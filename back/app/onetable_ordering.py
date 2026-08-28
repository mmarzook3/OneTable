"""Scanaki unattended-ordering policy and kitchen device API."""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
import json
import logging
import os
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from jose import JWTError, jwt
from pydantic import BaseModel, Field
import redis
from sqlmodel import Session, delete, select

from . import models
from .db import get_session
from .kitchen_stations_util import normalize_display_route
from .permissions import Permission, require_permission
from . import location_service as location_svc
from .opening_hours_effective import opening_service_windows_for_date
from .settings import settings


router = APIRouter()
logger = logging.getLogger(__name__)
_pulse_redis: redis.Redis | None = None

ORDERING_MODES = {"activation_pin", "automatic", "menu_only"}
DAY_NAMES = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)


def _get_pulse_redis() -> redis.Redis | None:
    global _pulse_redis
    if _pulse_redis is not None:
        return _pulse_redis
    try:
        client = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))
        client.ping()
        _pulse_redis = client
        return client
    except Exception:
        _pulse_redis = None
        return None


def record_kds_pulse(tenant_id: int, device_key: str, at: datetime | None = None) -> bool:
    client = _get_pulse_redis()
    if client is None:
        return False
    occurred_at = _as_utc(at or datetime.now(timezone.utc))
    try:
        value = occurred_at.isoformat()
        pipeline = client.pipeline(transaction=False)
        pipeline.set(f"kds:pulse:{tenant_id}:latest", value, ex=300)
        pipeline.set(f"kds:pulse:{tenant_id}:{device_key}", value, ex=300)
        pipeline.execute()
        return True
    except Exception:
        return False


def latest_kds_pulse_at(tenant_id: int) -> datetime | None:
    client = _get_pulse_redis()
    if client is None:
        return None
    try:
        value = client.get(f"kds:pulse:{tenant_id}:latest")
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        return _as_utc(datetime.fromisoformat(str(value))) if value else None
    except Exception:
        return None


def _pulse_identity(request: Request) -> tuple[int, str]:
    token = request.cookies.get("access_token")
    if not token:
        authorization = request.headers.get("authorization") or ""
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        tenant_id = int(payload["tenant_id"])
        subject = str(payload["sub"])
        if tenant_id <= 0 or not subject:
            raise ValueError
        return tenant_id, subject
    except (JWTError, KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Could not validate credentials")


def normalize_ordering_mode(value: str | None) -> str:
    mode = (value or "activation_pin").strip().lower()
    if mode not in ORDERING_MODES:
        raise ValueError("ordering_mode must be activation_pin, automatic, or menu_only")
    return mode


def validate_ordering_service_hours(value: dict[str, Any] | None) -> dict[str, Any] | None:
    """Validate weekly service windows without changing their admin-friendly shape."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("ordering_service_hours must be an object")
    unknown = set(value) - set(DAY_NAMES)
    if unknown:
        raise ValueError(f"Unknown service-hour days: {', '.join(sorted(unknown))}")
    for day, raw in value.items():
        windows = raw if isinstance(raw, list) else [raw]
        for window in windows:
            if window is None:
                continue
            if not isinstance(window, dict):
                raise ValueError(f"{day} service hours must be an object or list")
            if bool(window.get("closed")):
                continue
            _parse_clock(window.get("open"), f"{day}.open")
            _parse_clock(window.get("close"), f"{day}.close")
    return value


def _parse_clock(value: Any, label: str) -> time:
    if not isinstance(value, str):
        raise ValueError(f"{label} must use HH:MM")
    try:
        parsed = time.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValueError(f"{label} must use HH:MM") from exc
    return parsed.replace(second=0, microsecond=0)


def _service_windows_for_day(
    hours: dict[str, Any], day_index: int
) -> list[tuple[time, time]]:
    raw = hours.get(DAY_NAMES[day_index])
    if raw is None:
        return []
    rows = raw if isinstance(raw, list) else [raw]
    windows: list[tuple[time, time]] = []
    for row in rows:
        if not isinstance(row, dict) or bool(row.get("closed")):
            continue
        try:
            windows.append((_parse_clock(row.get("open"), "open"), _parse_clock(row.get("close"), "close")))
        except ValueError:
            continue
    return windows


def _within_service_hours(tenant: models.Tenant, now: datetime) -> bool:
    hours = getattr(tenant, "ordering_service_hours", None)
    if not hours:
        legacy_hours = getattr(tenant, "opening_hours", None)
        if not legacy_hours:
            return True
        try:
            hours = json.loads(legacy_hours) if isinstance(legacy_hours, str) else legacy_hours
        except (TypeError, ValueError):
            return True
    return _within_hours(hours, now)


def _within_hours(hours: dict[str, Any] | None, now: datetime) -> bool:
    if not hours:
        return True
    try:
        validate_ordering_service_hours(hours)
    except ValueError:
        return False

    local_time = now.timetz().replace(tzinfo=None)
    today = now.weekday()
    for opens, closes in _service_windows_for_day(hours, today):
        if opens <= closes and opens <= local_time < closes:
            return True
        if opens > closes and local_time >= opens:
            return True

    previous = (today - 1) % 7
    for opens, closes in _service_windows_for_day(hours, previous):
        if opens > closes and local_time < closes:
            return True
    return False


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _within_effective_tenant_opening_hours(
    session: Session,
    tenant: models.Tenant,
    local_now: datetime,
) -> bool:
    """Apply tenant baseline/date exceptions, including overnight carry-over."""
    today_windows = opening_service_windows_for_date(session, tenant, local_now.date())
    if today_windows is None:
        return True
    local_time = local_now.timetz().replace(tzinfo=None)
    for opens, closes in today_windows:
        if opens <= closes and opens <= local_time < closes:
            return True
        if opens > closes and local_time >= opens:
            return True
    previous_windows = opening_service_windows_for_date(
        session, tenant, (local_now - timedelta(days=1)).date()
    ) or []
    return any(opens > closes and local_time < closes for opens, closes in previous_windows)


def ordering_availability(
    session: Session,
    tenant: models.Tenant,
    *,
    now: datetime | None = None,
    location: models.TenantLocation | None = None,
    point: models.Table | None = None,
) -> dict[str, Any]:
    """Return the public ordering decision and an explanation suitable for UI/API use."""
    mode = normalize_ordering_mode(getattr(tenant, "ordering_mode", None))
    try:
        tz = ZoneInfo(tenant.timezone or "Europe/London")
    except (KeyError, ValueError):
        tz = timezone.utc
    local_now = (now or datetime.now(timezone.utc)).astimezone(tz)

    result: dict[str, Any] = {
        "allowed": True,
        "code": "OPEN",
        "customer_message": "Ordering is available.",
        "staff_message": None,
        "ordering_mode": mode,
        "strict_fifo_kds": bool(getattr(tenant, "strict_fifo_kds", True)),
        "checked_at": local_now.isoformat(),
        "kds_online": None,
        "location_id": location.id if location else None,
        "service_point_id": point.id if point else None,
    }
    if mode == "menu_only":
        result.update(
            allowed=False,
            code="MENU_ONLY",
            customer_message="Ordering is currently unavailable. You can still browse the menu.",
            staff_message="Tenant is configured for menu-only mode.",
        )
        return result
    if bool(getattr(tenant, "ordering_paused", False)):
        reason = (getattr(tenant, "ordering_pause_reason", None) or "Ordering is temporarily paused.").strip()
        result.update(
            allowed=False,
            code="PAUSED",
            customer_message=reason,
            staff_message=reason,
        )
        return result
    if location is not None and not location.is_active:
        result.update(
            allowed=False,
            code="LOCATION_INACTIVE",
            customer_message="This location is currently unavailable.",
            staff_message="The location is archived or inactive.",
        )
        return result
    if location is not None and location.ordering_paused:
        reason = (location.ordering_pause_reason or "Ordering is temporarily paused at this location.").strip()
        result.update(
            allowed=False,
            code="LOCATION_PAUSED",
            customer_message=reason,
            staff_message=reason,
        )
        return result
    if point is not None and not point.is_ordering_enabled:
        result.update(
            allowed=False,
            code="ORDERING_POINT_DISABLED",
            customer_message="Ordering is currently unavailable for this table or room.",
            staff_message="The ordering point is disabled.",
        )
        return result

    exception = location_svc.date_override(session, location, local_now.date())
    if exception is not None and exception.is_closed:
        result.update(
            allowed=False,
            code="LOCATION_CLOSED",
            customer_message="This location is closed today. You can still browse the menu.",
            staff_message="A location date override closes ordering today.",
        )
        return result
    if location is not None and location.hours_mode == "override":
        opening_hours = (
            exception.opening_hours
            if exception is not None and exception.opening_hours is not None
            else location_svc.effective_hours(tenant, location, kind="opening")
        )
        opening_allowed = _within_hours(opening_hours, local_now)
    else:
        opening_allowed = _within_effective_tenant_opening_hours(
            session, tenant, local_now
        )
    if not opening_allowed:
        result.update(
            allowed=False,
            code="LOCATION_CLOSED",
            customer_message="This location is currently closed. You can still browse the menu.",
            staff_message="Current time is outside the effective opening hours.",
        )
        return result
    hours = (
        exception.ordering_hours
        if exception is not None and exception.ordering_hours is not None
        else location_svc.effective_hours(tenant, location, kind="ordering")
    )
    if not _within_hours(hours, local_now):
        result.update(
            allowed=False,
            code="OUTSIDE_SERVICE_HOURS",
            customer_message="The menu is available, but ordering is closed right now.",
            staff_message="Current time is outside the configured ordering service hours.",
        )
        return result

    if bool(getattr(tenant, "require_kds_online", False)):
        timeout = max(30, min(int(getattr(tenant, "kds_heartbeat_timeout_seconds", 120) or 120), 900))
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout)
        pulse_at = latest_kds_pulse_at(tenant.id)
        devices = session.exec(
            select(models.KitchenDevice).where(
                models.KitchenDevice.tenant_id == tenant.id,
                models.KitchenDevice.revoked_at.is_(None),
            )
        ).all()
        online = bool(pulse_at and pulse_at >= cutoff) or any(
            _as_utc(device.last_seen_at) >= cutoff for device in devices
        )
        result["kds_online"] = online
        if not online:
            result.update(
                allowed=False,
                code="KDS_OFFLINE",
                customer_message="Ordering is temporarily unavailable. Please order with a member of staff.",
                staff_message="No kitchen display heartbeat was received within the timeout.",
            )
    return result


class KitchenHeartbeat(BaseModel):
    device_key: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(default="Kitchen tablet", min_length=1, max_length=120)
    display_route: str = Field(default="kitchen", max_length=16)
    station_id: int | None = None


class KitchenHeartbeatDiagnosticEvent(BaseModel):
    source: str = Field(pattern=r"^(native|web|server)$")
    outcome: str = Field(pattern=r"^(failure|recovered|heartbeat_gap|auth_failure)$")
    occurred_at: datetime
    status_code: int | None = Field(default=None, ge=0, le=599)
    duration_ms: int | None = Field(default=None, ge=0, le=300_000)
    consecutive_failures: int = Field(default=0, ge=0, le=1000)
    network_type: str | None = Field(default=None, max_length=32)
    wifi_enabled: bool | None = None
    network_validated: bool | None = None
    detail: str | None = Field(default=None, max_length=500)


class KitchenHeartbeatDiagnosticBatch(BaseModel):
    device_key: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    events: list[KitchenHeartbeatDiagnosticEvent] = Field(min_length=1, max_length=50)


class OrderingPause(BaseModel):
    reason: str | None = Field(default=None, max_length=240)


@router.get("/tenant/ordering-status")
def get_ordering_status(
    current_user: Annotated[models.User, Depends(require_permission(Permission.ORDER_READ))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant = session.get(models.Tenant, current_user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return ordering_availability(session, tenant)


@router.post("/tenant/ordering/pause")
def pause_ordering(
    body: OrderingPause,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant = session.get(models.Tenant, current_user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    tenant.ordering_paused = True
    tenant.ordering_pause_reason = (body.reason or "Ordering is temporarily paused.").strip()
    session.add(tenant)
    session.commit()
    return ordering_availability(session, tenant)


@router.post("/tenant/ordering/resume")
def resume_ordering(
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant = session.get(models.Tenant, current_user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    tenant.ordering_paused = False
    tenant.ordering_pause_reason = None
    session.add(tenant)
    session.commit()
    return ordering_availability(session, tenant)


@router.post("/tenant/kitchen-devices/pulse")
async def kitchen_device_pulse(
    body: KitchenHeartbeat,
    request: Request,
) -> dict[str, Any]:
    """Priority liveness pulse: JWT validation + Redis only, with no SQL dependency."""
    tenant_id, _subject = _pulse_identity(request)
    route = normalize_display_route(body.display_route)
    occurred_at = datetime.now(timezone.utc)
    if not record_kds_pulse(tenant_id, body.device_key, occurred_at):
        raise HTTPException(status_code=503, detail="Kitchen liveness cache is unavailable")
    return {
        "online": True,
        "device_key": body.device_key,
        "display_route": route,
        "last_seen_at": occurred_at.isoformat(),
    }


@router.get("/tenant/kitchen-devices")
def list_kitchen_devices(
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_READ))],
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    tenant = session.get(models.Tenant, current_user.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    timeout = max(30, int(tenant.kds_heartbeat_timeout_seconds or 120))
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout)
    rows = session.exec(
        select(models.KitchenDevice)
        .where(models.KitchenDevice.tenant_id == current_user.tenant_id)
        .order_by(models.KitchenDevice.last_seen_at.desc())
    ).all()
    return [
        {
            "id": row.id,
            "device_key": row.device_key,
            "name": row.name,
            "display_route": row.display_route,
            "station_id": row.station_id,
            "last_seen_at": row.last_seen_at.isoformat(),
            "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
            "online": row.revoked_at is None and _as_utc(row.last_seen_at) >= cutoff,
        }
        for row in rows
    ]


def _heartbeat_diagnostic_dict(row: models.KitchenHeartbeatDiagnostic) -> dict[str, Any]:
    return {
        "id": row.id,
        "device_key": row.device_key,
        "source": row.source,
        "outcome": row.outcome,
        "occurred_at": row.occurred_at.isoformat(),
        "received_at": row.received_at.isoformat(),
        "status_code": row.status_code,
        "duration_ms": row.duration_ms,
        "consecutive_failures": row.consecutive_failures,
        "network_type": row.network_type,
        "wifi_enabled": row.wifi_enabled,
        "network_validated": row.network_validated,
        "detail": row.detail,
    }


@router.get("/tenant/kitchen-devices/diagnostics")
def list_kitchen_heartbeat_diagnostics(
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_READ))],
    device_key: str | None = Query(default=None, min_length=16, max_length=64),
    limit: int = Query(default=100, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    query = select(models.KitchenHeartbeatDiagnostic).where(
        models.KitchenHeartbeatDiagnostic.tenant_id == current_user.tenant_id
    )
    if device_key:
        query = query.where(models.KitchenHeartbeatDiagnostic.device_key == device_key)
    rows = session.exec(
        query.order_by(models.KitchenHeartbeatDiagnostic.occurred_at.desc()).limit(limit)
    ).all()
    return [_heartbeat_diagnostic_dict(row) for row in rows]


@router.post("/tenant/kitchen-devices/diagnostics")
def record_kitchen_heartbeat_diagnostics(
    body: KitchenHeartbeatDiagnosticBatch,
    current_user: Annotated[models.User, Depends(require_permission(Permission.ORDER_READ))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    received_at = datetime.now(timezone.utc)
    session.exec(
        delete(models.KitchenHeartbeatDiagnostic).where(
            models.KitchenHeartbeatDiagnostic.tenant_id == current_user.tenant_id,
            models.KitchenHeartbeatDiagnostic.received_at
            < received_at - timedelta(days=30),
        )
    )
    for event in body.events:
        row = models.KitchenHeartbeatDiagnostic(
            tenant_id=current_user.tenant_id,
            device_key=body.device_key,
            source=event.source,
            outcome=event.outcome,
            occurred_at=_as_utc(event.occurred_at),
            received_at=received_at,
            status_code=event.status_code,
            duration_ms=event.duration_ms,
            consecutive_failures=event.consecutive_failures,
            network_type=(event.network_type or "").strip() or None,
            wifi_enabled=event.wifi_enabled,
            network_validated=event.network_validated,
            detail=(event.detail or "").strip()[:500] or None,
        )
        session.add(row)
        log = logger.warning if event.outcome in {"failure", "heartbeat_gap", "auth_failure"} else logger.info
        log(
            "kds_heartbeat_diagnostic tenant_id=%s device_key=%s source=%s outcome=%s "
            "status=%s duration_ms=%s consecutive_failures=%s network=%s detail=%s",
            current_user.tenant_id,
            body.device_key,
            event.source,
            event.outcome,
            event.status_code,
            event.duration_ms,
            event.consecutive_failures,
            event.network_type,
            event.detail,
        )
    session.commit()
    return {"status": "recorded", "count": len(body.events)}


@router.post("/tenant/kitchen-devices/heartbeat")
def kitchen_device_heartbeat(
    body: KitchenHeartbeat,
    current_user: Annotated[models.User, Depends(require_permission(Permission.ORDER_READ))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    route = normalize_display_route(body.display_route)
    if body.station_id is not None:
        station = session.get(models.KitchenStation, body.station_id)
        if not station or station.tenant_id != current_user.tenant_id:
            raise HTTPException(status_code=400, detail="Kitchen station does not belong to this tenant")
    device = session.exec(
        select(models.KitchenDevice).where(
            models.KitchenDevice.tenant_id == current_user.tenant_id,
            models.KitchenDevice.device_key == body.device_key,
        )
    ).first()
    if device and device.revoked_at is not None:
        raise HTTPException(status_code=403, detail="Kitchen device has been revoked")
    server_gap_seconds: int | None = None
    if device:
        tenant = session.get(models.Tenant, current_user.tenant_id)
        timeout = max(30, min(int(getattr(tenant, "kds_heartbeat_timeout_seconds", 120) or 120), 900))
        server_gap_seconds = max(
            0,
            int((datetime.now(timezone.utc) - _as_utc(device.last_seen_at)).total_seconds()),
        )
        if server_gap_seconds > max(timeout, 45):
            session.add(
                models.KitchenHeartbeatDiagnostic(
                    tenant_id=current_user.tenant_id,
                    device_key=body.device_key,
                    source="server",
                    outcome="heartbeat_gap",
                    occurred_at=datetime.now(timezone.utc),
                    status_code=200,
                    duration_ms=None,
                    consecutive_failures=max(1, server_gap_seconds // 10),
                    detail=f"Server observed a {server_gap_seconds}s gap between successful heartbeats.",
                )
            )
    if not device:
        device = models.KitchenDevice(
            tenant_id=current_user.tenant_id,
            device_key=body.device_key,
            name=body.name.strip(),
        )
    device.name = body.name.strip()
    device.display_route = route
    device.station_id = body.station_id
    device.last_seen_at = datetime.now(timezone.utc)
    session.add(device)
    session.commit()
    session.refresh(device)
    record_kds_pulse(current_user.tenant_id, body.device_key, device.last_seen_at)
    return {
        "id": device.id,
        "online": True,
        "last_seen_at": device.last_seen_at.isoformat(),
        "server_gap_seconds": server_gap_seconds,
    }


@router.delete("/tenant/kitchen-devices/{device_id}")
def revoke_kitchen_device(
    device_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    device = session.get(models.KitchenDevice, device_id)
    if not device or device.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=404, detail="Kitchen device not found")
    device.revoked_at = datetime.now(timezone.utc)
    session.add(device)
    session.commit()
    return {"status": "revoked", "id": device.id}
