"""Scanaki unattended-ordering policy and kitchen device API."""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
import json
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from . import models
from .db import get_session
from .kitchen_stations_util import normalize_display_route
from .permissions import Permission, require_permission


router = APIRouter()

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


def ordering_availability(
    session: Session,
    tenant: models.Tenant,
    *,
    now: datetime | None = None,
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
    if not _within_service_hours(tenant, local_now):
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
        devices = session.exec(
            select(models.KitchenDevice).where(
                models.KitchenDevice.tenant_id == tenant.id,
                models.KitchenDevice.revoked_at.is_(None),
            )
        ).all()
        online = any(_as_utc(device.last_seen_at) >= cutoff for device in devices)
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
    return {"id": device.id, "online": True, "last_seen_at": device.last_seen_at.isoformat()}


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
