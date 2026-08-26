"""Reusable Scanaki QR/NFC plaque inventory, assignment, and public resolution."""

from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
import re
import secrets
from typing import Annotated, Any
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlmodel import Field, Session, SQLModel, select

from . import models
from .db import get_session
from .permissions import Permission, require_permission
from .rate_limits import public_menu_ip_limit
from .security import get_current_user
from .settings import settings


router = APIRouter()

_PLAQUE_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_BATCH_LIMIT = 100


class SmartPlaqueBatchCreate(SQLModel):
    count: int = Field(default=1, ge=1, le=_BATCH_LIMIT)
    batch_label: str | None = Field(default=None, max_length=100)


class SmartPlaqueAssign(SQLModel):
    table_id: int = Field(gt=0)
    plaque_code: str = Field(min_length=1, max_length=500)
    confirm_reassignment: bool = False
    replace_existing: bool = False


class SmartPlaqueNfcUpdate(SQLModel):
    written: bool | None = None
    verified: bool | None = None
    locked: bool | None = None
    installed: bool | None = None


class SmartPlaqueRequestCreate(SQLModel):
    quantity: int = Field(ge=1, le=_BATCH_LIMIT)
    delivery_contact_name: str = Field(min_length=2, max_length=160)
    delivery_address: str = Field(min_length=8, max_length=500)
    restaurant_notes: str | None = Field(default=None, max_length=500)


class SmartPlaqueRequestAction(SQLModel):
    action: str = Field(min_length=2, max_length=32)
    tracking_reference: str | None = Field(default=None, max_length=160)
    platform_notes: str | None = Field(default=None, max_length=500)


class SmartPlaqueRequestEventResponse(SQLModel):
    action: str
    actor_user_id: int | None = None
    detail: dict | None = None
    created_at: datetime


class SmartPlaqueResponse(SQLModel):
    id: int
    public_code: str
    public_url: str
    batch_label: str | None = None
    status: str
    request_id: int | None = None
    assigned_tenant_id: int | None = None
    table_id: int | None = None
    table_name: str | None = None
    table_token: str | None = None
    assigned_at: datetime | None = None
    nfc_written_at: datetime | None = None
    nfc_verified_at: datetime | None = None
    nfc_locked_at: datetime | None = None
    installed_at: datetime | None = None


class SmartPlaqueRequestResponse(SQLModel):
    id: int
    tenant_id: int
    tenant_name: str
    requested_by_user_id: int | None = None
    requester_email: str | None = None
    quantity: int
    status: str
    delivery_contact_name: str
    delivery_address: str
    restaurant_notes: str | None = None
    platform_notes: str | None = None
    tracking_reference: str | None = None
    requested_at: datetime
    approved_at: datetime | None = None
    preparing_at: datetime | None = None
    shipped_at: datetime | None = None
    delivered_at: datetime | None = None
    completed_at: datetime | None = None
    declined_at: datetime | None = None
    cancelled_at: datetime | None = None
    updated_at: datetime
    allocated_count: int
    installed_count: int
    plaques: list[SmartPlaqueResponse]
    history: list[SmartPlaqueRequestEventResponse]


class SmartPlaqueLookupResponse(SmartPlaqueResponse):
    assignment_state: str


class PublicSmartPlaqueResolution(SQLModel):
    public_code: str
    menu_path: str
    tenant_name: str
    table_name: str


def _require_platform_operator(
    current_user: Annotated[models.User, Depends(get_current_user)],
) -> models.User:
    if (
        current_user.role != models.UserRole.platform_operator
        or current_user.tenant_id is not None
        or current_user.provider_id is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Platform operator account required",
        )
    return current_user


def _public_url(public_code: str) -> str:
    base = (settings.public_app_base_url or "").strip().rstrip("/")
    if not base or not base.lower().startswith(("https://", "http://")):
        raise HTTPException(
            status_code=503,
            detail="PUBLIC_APP_BASE_URL is required for permanent plaque URLs",
        )
    return f"{base}/p/{public_code}"


def _normalize_code(raw: str) -> str:
    value = (raw or "").replace("\x00", "").strip()
    if "://" in value:
        parsed = urlparse(value)
        if parsed.scheme.lower() not in {"http", "https"}:
            raise HTTPException(status_code=400, detail="The QR code is not a valid Scanaki URL")
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if len(parts) < 2 or parts[-2].lower() != "p":
            raise HTTPException(status_code=400, detail="This is not a Scanaki smart-plaque QR code")
        value = parts[-1]
    else:
        value = value.split("?", 1)[0].split("#", 1)[0].strip().strip("/")
        if "/" in value:
            parts = [unquote(part) for part in value.split("/") if part]
            if len(parts) < 2 or parts[-2].lower() != "p":
                raise HTTPException(status_code=400, detail="This is not a Scanaki smart-plaque code")
            value = parts[-1]
    if not _PLAQUE_CODE_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="Invalid Scanaki smart-plaque code")
    return value


def _table_for_tenant(session: Session, table_id: int, tenant_id: int) -> models.Table:
    table = session.exec(
        select(models.Table).where(
            models.Table.id == table_id,
            models.Table.tenant_id == tenant_id,
        )
    ).first()
    if table is None:
        raise HTTPException(status_code=404, detail="Table not found")
    return table


def _live_table_session(session: Session, table: models.Table) -> bool:
    if table.is_active or table.active_order_id is not None:
        return True
    return session.exec(
        select(models.Order.id).where(
            models.Order.table_id == table.id,
            models.Order.deleted_at.is_(None),
            models.Order.status.in_(
                (
                    models.OrderStatus.pending,
                    models.OrderStatus.preparing,
                    models.OrderStatus.ready,
                    models.OrderStatus.partially_delivered,
                    models.OrderStatus.completed,
                )
            ),
        ).limit(1)
    ).first() is not None


def _assert_safe_to_reassign(session: Session, table: models.Table) -> None:
    if _live_table_session(session, table):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "table_has_live_session",
                "message": f"Close the active session or order on {table.name} before moving its plaque.",
            },
        )


def _rotate_table_access(table: models.Table, now: datetime) -> None:
    table.token = secrets.token_hex(16)
    table.assignment_version = int(table.assignment_version or 1) + 1
    table.token_rotated_at = now
    table.plaque_status = "not_created"
    table.plaque_last_tested_at = None
    table.nfc_written_at = None
    table.nfc_locked_at = None


def _record_event(
    session: Session,
    plaque: models.SmartPlaque,
    *,
    action: str,
    actor_user_id: int | None,
    from_tenant_id: int | None,
    from_table_id: int | None,
    to_tenant_id: int | None,
    to_table_id: int | None,
) -> None:
    session.add(
        models.SmartPlaqueAssignmentEvent(
            plaque_id=int(plaque.id),
            action=action,
            actor_user_id=actor_user_id,
            from_tenant_id=from_tenant_id,
            from_table_id=from_table_id,
            to_tenant_id=to_tenant_id,
            to_table_id=to_table_id,
        )
    )


def _unassign_plaque(plaque: models.SmartPlaque, now: datetime) -> None:
    plaque.status = "available"
    plaque.request_id = None
    plaque.assigned_tenant_id = None
    plaque.table_id = None
    plaque.assigned_by_user_id = None
    plaque.assigned_at = None
    plaque.installed_at = None
    plaque.updated_at = now


def _response(session: Session, plaque: models.SmartPlaque) -> SmartPlaqueResponse:
    table = session.get(models.Table, plaque.table_id) if plaque.table_id else None
    return SmartPlaqueResponse(
        id=int(plaque.id),
        public_code=plaque.public_code,
        public_url=_public_url(plaque.public_code),
        batch_label=plaque.batch_label,
        status=plaque.status,
        request_id=plaque.request_id,
        assigned_tenant_id=plaque.assigned_tenant_id,
        table_id=plaque.table_id,
        table_name=table.name if table else None,
        table_token=table.token if table else None,
        assigned_at=plaque.assigned_at,
        nfc_written_at=plaque.nfc_written_at,
        nfc_verified_at=plaque.nfc_verified_at,
        nfc_locked_at=plaque.nfc_locked_at,
        installed_at=plaque.installed_at,
    )


def _record_request_event(
    session: Session,
    request_row: models.SmartPlaqueRequest,
    *,
    action: str,
    actor_user_id: int | None,
    detail: dict | None = None,
) -> None:
    session.add(
        models.SmartPlaqueRequestEvent(
            request_id=int(request_row.id),
            action=action,
            actor_user_id=actor_user_id,
            detail=detail,
        )
    )


def _request_response(
    session: Session,
    request_row: models.SmartPlaqueRequest,
) -> SmartPlaqueRequestResponse:
    tenant = session.get(models.Tenant, request_row.tenant_id)
    requester = (
        session.get(models.User, request_row.requested_by_user_id)
        if request_row.requested_by_user_id
        else None
    )
    plaques = session.exec(
        select(models.SmartPlaque)
        .where(models.SmartPlaque.request_id == request_row.id)
        .order_by(models.SmartPlaque.id)
    ).all()
    events = session.exec(
        select(models.SmartPlaqueRequestEvent)
        .where(models.SmartPlaqueRequestEvent.request_id == request_row.id)
        .order_by(models.SmartPlaqueRequestEvent.created_at)
    ).all()
    return SmartPlaqueRequestResponse(
        id=int(request_row.id),
        tenant_id=request_row.tenant_id,
        tenant_name=tenant.name if tenant else f"Tenant {request_row.tenant_id}",
        requested_by_user_id=request_row.requested_by_user_id,
        requester_email=requester.email if requester else None,
        quantity=request_row.quantity,
        status=request_row.status,
        delivery_contact_name=request_row.delivery_contact_name,
        delivery_address=request_row.delivery_address,
        restaurant_notes=request_row.restaurant_notes,
        platform_notes=request_row.platform_notes,
        tracking_reference=request_row.tracking_reference,
        requested_at=request_row.requested_at,
        approved_at=request_row.approved_at,
        preparing_at=request_row.preparing_at,
        shipped_at=request_row.shipped_at,
        delivered_at=request_row.delivered_at,
        completed_at=request_row.completed_at,
        declined_at=request_row.declined_at,
        cancelled_at=request_row.cancelled_at,
        updated_at=request_row.updated_at,
        allocated_count=len(plaques),
        installed_count=sum(1 for plaque in plaques if plaque.status == "installed"),
        plaques=[_response(session, plaque) for plaque in plaques],
        history=[
            SmartPlaqueRequestEventResponse(
                action=event.action,
                actor_user_id=event.actor_user_id,
                detail=event.detail,
                created_at=event.created_at,
            )
            for event in events
        ],
    )


def _allocate_request_plaques(
    session: Session,
    request_row: models.SmartPlaqueRequest,
    operator: models.User,
) -> list[models.SmartPlaque]:
    rows = session.exec(
        select(models.SmartPlaque)
        .where(
            models.SmartPlaque.status == "available",
            models.SmartPlaque.assigned_tenant_id.is_(None),
            models.SmartPlaque.table_id.is_(None),
        )
        .order_by(models.SmartPlaque.id)
        .limit(request_row.quantity)
    ).all()
    batch_label = f"Request #{request_row.id} · {session.get(models.Tenant, request_row.tenant_id).name}"
    while len(rows) < request_row.quantity:
        while True:
            code = secrets.token_urlsafe(18)
            if not session.exec(
                select(models.SmartPlaque.id).where(models.SmartPlaque.public_code == code)
            ).first():
                break
        plaque = models.SmartPlaque(
            public_code=code,
            batch_label=batch_label,
            created_by_user_id=operator.id,
        )
        session.add(plaque)
        session.flush()
        rows.append(plaque)
    for plaque in rows:
        plaque.status = "reserved"
        plaque.request_id = request_row.id
        plaque.assigned_tenant_id = request_row.tenant_id
        plaque.updated_at = datetime.now(timezone.utc)
        if not plaque.batch_label:
            plaque.batch_label = batch_label
        session.add(plaque)
    return rows


def _release_request_plaques(
    session: Session,
    request_row: models.SmartPlaqueRequest,
) -> None:
    now = datetime.now(timezone.utc)
    plaques = session.exec(
        select(models.SmartPlaque).where(
            models.SmartPlaque.request_id == request_row.id,
            models.SmartPlaque.table_id.is_(None),
        )
    ).all()
    for plaque in plaques:
        _unassign_plaque(plaque, now)
        session.add(plaque)


def _complete_request_if_ready(
    session: Session,
    request_row: models.SmartPlaqueRequest | None,
    *,
    actor_user_id: int | None,
) -> None:
    if request_row is None or request_row.status not in {"delivered", "completed"}:
        return
    plaques = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.request_id == request_row.id)
    ).all()
    if len(plaques) != request_row.quantity or any(
        plaque.status != "installed" for plaque in plaques
    ):
        return
    if request_row.status != "completed":
        now = datetime.now(timezone.utc)
        request_row.status = "completed"
        request_row.completed_at = now
        request_row.updated_at = now
        session.add(request_row)
        _record_request_event(
            session,
            request_row,
            action="completed",
            actor_user_id=actor_user_id,
            detail={"installed_count": len(plaques)},
        )


def smart_plaque_fields_by_table(
    session: Session,
    tenant_id: int,
    table_ids: list[int],
) -> dict[int, dict[str, Any]]:
    """Return flattened smart-plaque fields for table list responses."""
    if not table_ids:
        return {}
    plaques = session.exec(
        select(models.SmartPlaque).where(
            models.SmartPlaque.assigned_tenant_id == tenant_id,
            models.SmartPlaque.table_id.in_(table_ids),
        )
    ).all()
    return {
        int(plaque.table_id): {
            "smart_plaque_id": plaque.id,
            "smart_plaque_code": plaque.public_code,
            "smart_plaque_url": _public_url(plaque.public_code),
            "smart_plaque_status": plaque.status,
            "smart_plaque_nfc_written_at": plaque.nfc_written_at,
            "smart_plaque_nfc_verified_at": plaque.nfc_verified_at,
            "smart_plaque_nfc_locked_at": plaque.nfc_locked_at,
            "smart_plaque_installed_at": plaque.installed_at,
        }
        for plaque in plaques
        if plaque.table_id is not None
    }


def release_smart_plaque_for_deleted_table(
    session: Session,
    table: models.Table,
    *,
    actor_user_id: int | None,
    action: str = "table_deleted",
) -> None:
    """Return a table's reusable plaque to inventory before deleting the table."""
    if table.id is None:
        return
    plaque = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.table_id == table.id)
    ).first()
    if plaque is None:
        return
    now = datetime.now(timezone.utc)
    from_tenant_id, from_table_id = plaque.assigned_tenant_id, plaque.table_id
    _unassign_plaque(plaque, now)
    session.add(plaque)
    _record_event(
        session,
        plaque,
        action=action,
        actor_user_id=actor_user_id,
        from_tenant_id=from_tenant_id,
        from_table_id=from_table_id,
        to_tenant_id=None,
        to_table_id=None,
    )


@router.post(
    "/smart-plaque-requests",
    response_model=SmartPlaqueRequestResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_smart_plaque_request(
    body: SmartPlaqueRequestCreate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> SmartPlaqueRequestResponse:
    tenant_id = int(current_user.tenant_id)
    active = session.exec(
        select(models.SmartPlaqueRequest).where(
            models.SmartPlaqueRequest.tenant_id == tenant_id,
            models.SmartPlaqueRequest.status.in_(
                ("requested", "approved", "preparing", "shipped")
            ),
        )
    ).first()
    if active is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "active_plaque_request_exists",
                "message": f"Request #{active.id} is already being processed.",
            },
        )
    now = datetime.now(timezone.utc)
    request_row = models.SmartPlaqueRequest(
        tenant_id=tenant_id,
        requested_by_user_id=current_user.id,
        quantity=body.quantity,
        delivery_contact_name=body.delivery_contact_name.strip(),
        delivery_address=body.delivery_address.strip(),
        restaurant_notes=(body.restaurant_notes or "").strip() or None,
        requested_at=now,
        updated_at=now,
    )
    session.add(request_row)
    session.flush()
    _record_request_event(
        session,
        request_row,
        action="requested",
        actor_user_id=current_user.id,
        detail={"quantity": body.quantity},
    )
    session.commit()
    session.refresh(request_row)
    return _request_response(session, request_row)


@router.get(
    "/smart-plaque-requests",
    response_model=list[SmartPlaqueRequestResponse],
)
def tenant_smart_plaque_requests(
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_READ))],
    session: Session = Depends(get_session),
) -> list[SmartPlaqueRequestResponse]:
    rows = session.exec(
        select(models.SmartPlaqueRequest)
        .where(models.SmartPlaqueRequest.tenant_id == current_user.tenant_id)
        .order_by(models.SmartPlaqueRequest.id.desc())
        .limit(100)
    ).all()
    return [_request_response(session, row) for row in rows]


@router.post(
    "/smart-plaque-requests/{request_id}/cancel",
    response_model=SmartPlaqueRequestResponse,
)
def cancel_tenant_smart_plaque_request(
    request_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> SmartPlaqueRequestResponse:
    request_row = session.exec(
        select(models.SmartPlaqueRequest).where(
            models.SmartPlaqueRequest.id == request_id,
            models.SmartPlaqueRequest.tenant_id == current_user.tenant_id,
        )
    ).first()
    if request_row is None:
        raise HTTPException(status_code=404, detail="Plaque request not found")
    if request_row.status != "requested":
        raise HTTPException(
            status_code=409,
            detail="Only a request awaiting approval can be cancelled.",
        )
    now = datetime.now(timezone.utc)
    request_row.status = "cancelled"
    request_row.cancelled_at = now
    request_row.updated_at = now
    session.add(request_row)
    _record_request_event(
        session,
        request_row,
        action="cancelled",
        actor_user_id=current_user.id,
    )
    session.commit()
    session.refresh(request_row)
    return _request_response(session, request_row)


@router.post(
    "/smart-plaque-requests/{request_id}/confirm-delivery",
    response_model=SmartPlaqueRequestResponse,
)
def confirm_smart_plaque_delivery(
    request_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> SmartPlaqueRequestResponse:
    request_row = session.exec(
        select(models.SmartPlaqueRequest).where(
            models.SmartPlaqueRequest.id == request_id,
            models.SmartPlaqueRequest.tenant_id == current_user.tenant_id,
        )
    ).first()
    if request_row is None:
        raise HTTPException(status_code=404, detail="Plaque request not found")
    if request_row.status != "shipped":
        raise HTTPException(status_code=409, detail="Only a shipped request can be received.")
    now = datetime.now(timezone.utc)
    request_row.status = "delivered"
    request_row.delivered_at = now
    request_row.updated_at = now
    plaques = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.request_id == request_row.id)
    ).all()
    for plaque in plaques:
        if plaque.status == "shipped":
            plaque.status = "delivered"
            plaque.updated_at = now
            session.add(plaque)
    session.add(request_row)
    _record_request_event(
        session,
        request_row,
        action="delivered",
        actor_user_id=current_user.id,
        detail={"received_count": len(plaques)},
    )
    session.commit()
    session.refresh(request_row)
    return _request_response(session, request_row)


@router.get(
    "/platform/smart-plaque-requests",
    response_model=list[SmartPlaqueRequestResponse],
)
def platform_smart_plaque_requests(
    operator: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
    request_status: str | None = Query(default=None, max_length=24),
) -> list[SmartPlaqueRequestResponse]:
    statement = select(models.SmartPlaqueRequest).order_by(
        models.SmartPlaqueRequest.id.desc()
    ).limit(500)
    if request_status:
        statement = statement.where(
            models.SmartPlaqueRequest.status == request_status.strip().lower()
        )
    return [_request_response(session, row) for row in session.exec(statement).all()]


@router.post(
    "/platform/smart-plaque-requests/{request_id}/action",
    response_model=SmartPlaqueRequestResponse,
)
def platform_smart_plaque_request_action(
    request_id: int,
    body: SmartPlaqueRequestAction,
    operator: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> SmartPlaqueRequestResponse:
    request_row = session.get(models.SmartPlaqueRequest, request_id)
    if request_row is None:
        raise HTTPException(status_code=404, detail="Plaque request not found")
    action = body.action.strip().lower()
    allowed = {
        "requested": {"approve", "decline"},
        "approved": {"prepare", "ship"},
        "preparing": {"ship"},
        "shipped": {"deliver"},
        "delivered": {"complete"},
    }
    if action not in allowed.get(request_row.status, set()):
        raise HTTPException(
            status_code=409,
            detail=f"Action {action} is not available while the request is {request_row.status}.",
        )
    now = datetime.now(timezone.utc)
    plaques = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.request_id == request_row.id)
    ).all()
    if action == "approve":
        plaques = _allocate_request_plaques(session, request_row, operator)
        request_row.status = "approved"
        request_row.approved_at = now
    elif action == "prepare":
        request_row.status = "preparing"
        request_row.preparing_at = now
        for plaque in plaques:
            if plaque.status == "reserved":
                plaque.status = "preparing"
                session.add(plaque)
    elif action == "ship":
        request_row.status = "shipped"
        request_row.shipped_at = now
        request_row.tracking_reference = (body.tracking_reference or "").strip() or None
        for plaque in plaques:
            if plaque.status in {"reserved", "preparing"}:
                plaque.status = "shipped"
                session.add(plaque)
    elif action == "deliver":
        request_row.status = "delivered"
        request_row.delivered_at = now
        for plaque in plaques:
            if plaque.status == "shipped":
                plaque.status = "delivered"
                session.add(plaque)
    elif action == "decline":
        request_row.status = "declined"
        request_row.declined_at = now
        _release_request_plaques(session, request_row)
    elif action == "complete":
        if len(plaques) != request_row.quantity or any(
            plaque.status != "installed" for plaque in plaques
        ):
            raise HTTPException(
                status_code=409,
                detail="Every allocated plaque must be installed before completion.",
            )
        request_row.status = "completed"
        request_row.completed_at = now
    request_row.platform_notes = (
        (body.platform_notes or "").strip() or request_row.platform_notes
    )
    request_row.updated_at = now
    session.add(request_row)
    _record_request_event(
        session,
        request_row,
        action={"approve": "approved", "prepare": "preparing", "ship": "shipped", "deliver": "delivered", "decline": "declined", "complete": "completed"}[action],
        actor_user_id=operator.id,
        detail={
            "allocated_count": len(plaques),
            "tracking_reference": request_row.tracking_reference,
        },
    )
    session.commit()
    session.refresh(request_row)
    return _request_response(session, request_row)


@router.post(
    "/platform/smart-plaques/batch",
    response_model=list[SmartPlaqueResponse],
    status_code=status.HTTP_201_CREATED,
)
def create_smart_plaque_batch(
    body: SmartPlaqueBatchCreate,
    operator: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> list[SmartPlaqueResponse]:
    batch_label = (body.batch_label or "").strip() or None
    rows: list[models.SmartPlaque] = []
    for _ in range(body.count):
        while True:
            code = secrets.token_urlsafe(18)
            if not session.exec(
                select(models.SmartPlaque.id).where(models.SmartPlaque.public_code == code)
            ).first():
                break
        plaque = models.SmartPlaque(
            public_code=code,
            batch_label=batch_label,
            created_by_user_id=operator.id,
        )
        session.add(plaque)
        rows.append(plaque)
    session.commit()
    for row in rows:
        session.refresh(row)
    return [_response(session, row) for row in rows]


@router.get("/platform/smart-plaques", response_model=list[SmartPlaqueResponse])
def platform_smart_plaques(
    operator: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
    batch_label: str | None = Query(default=None, max_length=100),
    request_id: int | None = Query(default=None, gt=0),
) -> list[SmartPlaqueResponse]:
    statement = select(models.SmartPlaque).order_by(models.SmartPlaque.id.desc()).limit(500)
    if batch_label:
        statement = statement.where(models.SmartPlaque.batch_label == batch_label.strip())
    if request_id is not None:
        statement = statement.where(models.SmartPlaque.request_id == request_id)
    return [_response(session, row) for row in session.exec(statement).all()]


@router.get("/platform/smart-plaques/contact-sheet.pdf")
def platform_smart_plaque_contact_sheet(
    operator: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
    batch_label: str | None = Query(default=None, max_length=100),
    request_id: int | None = Query(default=None, gt=0),
) -> StreamingResponse:
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen.canvas import Canvas

    statement = select(models.SmartPlaque).order_by(models.SmartPlaque.id)
    if batch_label:
        statement = statement.where(models.SmartPlaque.batch_label == batch_label.strip())
    if request_id is not None:
        statement = statement.where(models.SmartPlaque.request_id == request_id)
    plaques = session.exec(statement).all()
    if not plaques:
        raise HTTPException(status_code=404, detail="No smart plaques found")

    output = BytesIO()
    canvas = Canvas(output, pagesize=A4)
    page_width, page_height = A4
    margin, cols, rows_per_page = 32, 3, 5
    cell_width = (page_width - margin * 2) / cols
    cell_height = (page_height - margin * 2) / rows_per_page
    for index, plaque in enumerate(plaques):
        slot = index % (cols * rows_per_page)
        if slot == 0 and index:
            canvas.showPage()
        col, row = slot % cols, slot // cols
        x = margin + col * cell_width
        y = page_height - margin - (row + 1) * cell_height
        url = _public_url(plaque.public_code)
        canvas.roundRect(x + 5, y + 5, cell_width - 10, cell_height - 10, 7, stroke=1, fill=0)
        canvas.setFont("Helvetica-Bold", 11)
        canvas.drawString(x + 13, y + cell_height - 22, "Scanaki Smart Plaque")
        qr = QrCodeWidget(url, barLevel="H")
        bounds = qr.getBounds()
        size = min(105, cell_height - 48)
        drawing = Drawing(
            size,
            size,
            transform=[size / (bounds[2] - bounds[0]), 0, 0, size / (bounds[3] - bounds[1]), 0, 0],
        )
        drawing.add(qr)
        canvas.saveState()
        renderPDF.draw(drawing, canvas, x + 13, y + 28)
        canvas.restoreState()
        canvas.setFont("Helvetica", 6.5)
        canvas.drawString(x + 13, y + 17, plaque.public_code[:26])
        canvas.setFont("Helvetica-Bold", 7)
        canvas.drawRightString(x + cell_width - 13, y + 17, "Scan or tap to order")
    canvas.save()
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="scanaki-smart-plaques.pdf"'},
    )


@router.post(
    "/platform/smart-plaques/{plaque_id}/release",
    response_model=SmartPlaqueResponse,
)
def platform_release_smart_plaque(
    plaque_id: int,
    operator: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> SmartPlaqueResponse:
    plaque = session.get(models.SmartPlaque, plaque_id)
    if plaque is None:
        raise HTTPException(status_code=404, detail="Smart plaque not found")
    if plaque.table_id is None:
        return _response(session, plaque)
    table = session.get(models.Table, plaque.table_id)
    if table is not None:
        _assert_safe_to_reassign(session, table)
    now = datetime.now(timezone.utc)
    from_tenant_id, from_table_id = plaque.assigned_tenant_id, plaque.table_id
    if table is not None:
        _rotate_table_access(table, now)
        session.add(table)
    _unassign_plaque(plaque, now)
    session.add(plaque)
    _record_event(
        session,
        plaque,
        action="platform_release",
        actor_user_id=operator.id,
        from_tenant_id=from_tenant_id,
        from_table_id=from_table_id,
        to_tenant_id=None,
        to_table_id=None,
    )
    session.commit()
    session.refresh(plaque)
    return _response(session, plaque)


@router.delete("/platform/smart-plaques/{plaque_id}")
def delete_available_smart_plaque(
    plaque_id: int,
    operator: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> dict[str, int | str]:
    plaque = session.get(models.SmartPlaque, plaque_id)
    if plaque is None:
        raise HTTPException(status_code=404, detail="Smart plaque not found")
    if plaque.table_id is not None or plaque.assigned_tenant_id is not None:
        raise HTTPException(status_code=409, detail="Release this smart plaque before deleting it")
    session.delete(plaque)
    session.commit()
    return {"status": "deleted", "id": plaque_id}


@router.get("/smart-plaques", response_model=list[SmartPlaqueResponse])
def tenant_smart_plaques(
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_READ))],
    session: Session = Depends(get_session),
) -> list[SmartPlaqueResponse]:
    rows = session.exec(
        select(models.SmartPlaque)
        .where(models.SmartPlaque.assigned_tenant_id == current_user.tenant_id)
        .order_by(models.SmartPlaque.id)
    ).all()
    return [_response(session, row) for row in rows]


@router.get("/smart-plaques/lookup", response_model=SmartPlaqueLookupResponse)
def lookup_smart_plaque(
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    value: str = Query(min_length=1, max_length=500),
    session: Session = Depends(get_session),
) -> SmartPlaqueLookupResponse:
    code = _normalize_code(value)
    plaque = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.public_code == code)
    ).first()
    if plaque is None:
        raise HTTPException(status_code=404, detail="Smart plaque not found")
    base = _response(session, plaque)
    if plaque.status in {"disabled", "retired"}:
        assignment_state = plaque.status
    elif (
        plaque.status in {"reserved", "preparing", "shipped"}
        and plaque.assigned_tenant_id == current_user.tenant_id
        and plaque.table_id is None
    ):
        assignment_state = "awaiting_delivery"
    elif plaque.assigned_tenant_id is None:
        assignment_state = "available"
    elif plaque.assigned_tenant_id == current_user.tenant_id:
        assignment_state = "assigned_here"
    else:
        assignment_state = "assigned_other_restaurant"
        base = base.model_copy(
            update={
                "assigned_tenant_id": None,
                "table_id": None,
                "table_name": None,
                "table_token": None,
                "assigned_at": None,
            }
        )
    return SmartPlaqueLookupResponse(**base.model_dump(), assignment_state=assignment_state)


@router.post("/smart-plaques/assign", response_model=SmartPlaqueResponse)
def assign_smart_plaque(
    body: SmartPlaqueAssign,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> SmartPlaqueResponse:
    tenant_id = int(current_user.tenant_id)
    target = _table_for_tenant(session, body.table_id, tenant_id)
    code = _normalize_code(body.plaque_code)
    plaque = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.public_code == code)
    ).first()
    if plaque is None:
        raise HTTPException(status_code=404, detail="Smart plaque not found")
    if plaque.status in {"disabled", "retired"}:
        raise HTTPException(status_code=409, detail="This smart plaque is not available for assignment")
    if plaque.table_id is None and plaque.status in {"reserved", "preparing", "shipped"}:
        raise HTTPException(
            status_code=409,
            detail="Confirm delivery before assigning this smart plaque to a table.",
        )
    if plaque.assigned_tenant_id not in {None, tenant_id}:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "plaque_assigned_to_another_restaurant",
                "message": "This plaque must be released by Scanaki before another restaurant can use it.",
            },
        )
    if plaque.table_id == target.id and plaque.assigned_tenant_id == tenant_id:
        return _response(session, plaque)

    previous_table = session.get(models.Table, plaque.table_id) if plaque.table_id else None
    if previous_table is not None:
        _assert_safe_to_reassign(session, previous_table)
        if not body.confirm_reassignment:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "confirm_plaque_reassignment",
                    "message": f"This plaque is currently assigned to {previous_table.name}.",
                },
            )

    target_plaque = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.table_id == target.id)
    ).first()
    if target_plaque is not None and target_plaque.id != plaque.id:
        _assert_safe_to_reassign(session, target)
        if not body.replace_existing:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "confirm_replace_table_plaque",
                    "message": f"{target.name} already has a smart plaque assigned.",
                },
            )

    _assert_safe_to_reassign(session, target)
    now = datetime.now(timezone.utc)
    from_tenant_id, from_table_id = plaque.assigned_tenant_id, plaque.table_id

    if previous_table is not None:
        _rotate_table_access(previous_table, now)
        session.add(previous_table)
    if target_plaque is not None and target_plaque.id != plaque.id:
        _record_event(
            session,
            target_plaque,
            action="replaced",
            actor_user_id=current_user.id,
            from_tenant_id=target_plaque.assigned_tenant_id,
            from_table_id=target_plaque.table_id,
            to_tenant_id=None,
            to_table_id=None,
        )
        _unassign_plaque(target_plaque, now)
        session.add(target_plaque)

    _rotate_table_access(target, now)
    target.plaque_status = "installed"
    target.nfc_written_at = plaque.nfc_written_at
    target.nfc_locked_at = plaque.nfc_locked_at
    session.add(target)

    plaque.status = "assigned"
    plaque.assigned_tenant_id = tenant_id
    plaque.table_id = target.id
    plaque.assigned_by_user_id = current_user.id
    plaque.assigned_at = now
    plaque.installed_at = None
    plaque.updated_at = now
    session.add(plaque)
    _record_event(
        session,
        plaque,
        action="assigned" if from_table_id is None else "reassigned",
        actor_user_id=current_user.id,
        from_tenant_id=from_tenant_id,
        from_table_id=from_table_id,
        to_tenant_id=tenant_id,
        to_table_id=target.id,
    )
    session.commit()
    session.refresh(plaque)
    return _response(session, plaque)


@router.delete("/smart-plaques/{plaque_id}/assignment", response_model=SmartPlaqueResponse)
def release_tenant_smart_plaque(
    plaque_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> SmartPlaqueResponse:
    plaque = session.exec(
        select(models.SmartPlaque).where(
            models.SmartPlaque.id == plaque_id,
            models.SmartPlaque.assigned_tenant_id == current_user.tenant_id,
        )
    ).first()
    if plaque is None:
        raise HTTPException(status_code=404, detail="Assigned smart plaque not found")
    table = session.get(models.Table, plaque.table_id) if plaque.table_id else None
    if table is not None:
        _assert_safe_to_reassign(session, table)
    now = datetime.now(timezone.utc)
    from_tenant_id, from_table_id = plaque.assigned_tenant_id, plaque.table_id
    if table is not None:
        _rotate_table_access(table, now)
        session.add(table)
    _unassign_plaque(plaque, now)
    session.add(plaque)
    _record_event(
        session,
        plaque,
        action="tenant_release",
        actor_user_id=current_user.id,
        from_tenant_id=from_tenant_id,
        from_table_id=from_table_id,
        to_tenant_id=None,
        to_table_id=None,
    )
    session.commit()
    session.refresh(plaque)
    return _response(session, plaque)


@router.put("/smart-plaques/{plaque_id}/nfc", response_model=SmartPlaqueResponse)
def update_smart_plaque_nfc(
    plaque_id: int,
    body: SmartPlaqueNfcUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> SmartPlaqueResponse:
    plaque = session.exec(
        select(models.SmartPlaque).where(
            models.SmartPlaque.id == plaque_id,
            models.SmartPlaque.assigned_tenant_id == current_user.tenant_id,
        )
    ).first()
    if plaque is None:
        raise HTTPException(status_code=404, detail="Assigned smart plaque not found")
    now = datetime.now(timezone.utc)
    if body.written is True:
        plaque.nfc_written_at = now
    elif body.written is False:
        plaque.nfc_written_at = None
        plaque.nfc_verified_at = None
        plaque.nfc_locked_at = None
        plaque.installed_at = None
        plaque.status = "assigned"
    if body.verified is True:
        if plaque.nfc_written_at is None:
            raise HTTPException(status_code=409, detail="Write the NFC tag before verifying it")
        plaque.nfc_verified_at = now
        plaque.status = "tested"
    elif body.verified is False:
        plaque.nfc_verified_at = None
        plaque.nfc_locked_at = None
        plaque.installed_at = None
        plaque.status = "assigned"
    if body.locked is True:
        if plaque.nfc_verified_at is None:
            raise HTTPException(status_code=409, detail="Verify the NFC tag before marking it locked")
        plaque.nfc_locked_at = now
    elif body.locked is False:
        plaque.nfc_locked_at = None
    if body.installed is True:
        if plaque.nfc_verified_at is None:
            raise HTTPException(
                status_code=409,
                detail="Verify the NFC tag before marking the plaque installed",
            )
        plaque.installed_at = now
        plaque.status = "installed"
    elif body.installed is False:
        plaque.installed_at = None
        plaque.status = "tested" if plaque.nfc_verified_at else "assigned"
    plaque.updated_at = now
    session.add(plaque)
    table = session.get(models.Table, plaque.table_id) if plaque.table_id else None
    if table is not None:
        table.nfc_written_at = plaque.nfc_written_at
        table.nfc_locked_at = plaque.nfc_locked_at
        table.plaque_last_tested_at = plaque.nfc_verified_at
        table.plaque_status = "installed" if plaque.installed_at else (
            "tested" if plaque.nfc_verified_at else (
                "nfc_written" if plaque.nfc_written_at else "assigned"
            )
        )
        session.add(table)
    request_row = (
        session.get(models.SmartPlaqueRequest, plaque.request_id)
        if plaque.request_id
        else None
    )
    _complete_request_if_ready(
        session,
        request_row,
        actor_user_id=current_user.id,
    )
    session.commit()
    session.refresh(plaque)
    return _response(session, plaque)


@router.get(
    "/public/smart-plaques/{public_code}",
    response_model=PublicSmartPlaqueResolution,
)
@public_menu_ip_limit()
def resolve_public_smart_plaque(
    request: Request,
    response: Response,
    public_code: str,
    session: Session = Depends(get_session),
) -> PublicSmartPlaqueResolution:
    code = _normalize_code(public_code)
    plaque = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.public_code == code)
    ).first()
    if plaque is None:
        raise HTTPException(status_code=404, detail="Smart plaque not found")
    if plaque.status != "assigned" or plaque.table_id is None or plaque.assigned_tenant_id is None:
        raise HTTPException(status_code=409, detail="This smart plaque is not currently assigned")
    table = session.get(models.Table, plaque.table_id)
    tenant = session.get(models.Tenant, plaque.assigned_tenant_id)
    if table is None or tenant is None or table.tenant_id != tenant.id:
        raise HTTPException(status_code=409, detail="This smart plaque assignment is unavailable")
    return PublicSmartPlaqueResolution(
        public_code=plaque.public_code,
        menu_path=f"/menu/{table.token}",
        tenant_name=tenant.name,
        table_name=table.name,
    )
