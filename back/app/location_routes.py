"""Protected multi-location CRM, ordering-point, routing and reporting APIs."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import Session, select

from . import location_service as locations
from . import models
from .db import get_session
from .onetable_ordering import validate_ordering_service_hours
from .permissions import Permission, require_permission, require_role
from .saas_billing import tenant_table_limit
from .settings import settings


router = APIRouter()
_DAY_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


class LocationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    display_name: str = Field(min_length=1, max_length=160)
    slug: str | None = Field(default=None, max_length=120)
    location_type: str = Field(default="other", max_length=32)
    sort_order: int = 0


class LocationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    display_name: str | None = Field(default=None, min_length=1, max_length=160)
    slug: str | None = Field(default=None, min_length=1, max_length=120)
    location_type: str | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class PointCreate(BaseModel):
    display_number: str = Field(min_length=1, max_length=64)
    service_point_type: str = Field(default="table", max_length=16)
    name: str | None = Field(default=None, max_length=120)
    customer_label: str | None = Field(default=None, max_length=120)
    seat_count: int = Field(default=4, ge=1, le=50)
    floor_id: int | None = None
    is_ordering_enabled: bool = True


class PointUpdate(BaseModel):
    display_number: str | None = Field(default=None, min_length=1, max_length=64)
    service_point_type: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    customer_label: str | None = Field(default=None, max_length=120)
    seat_count: int | None = Field(default=None, ge=1, le=50)
    floor_id: int | None = None
    location_id: int | None = None
    is_ordering_enabled: bool | None = None


class PointBulkCreate(BaseModel):
    service_point_type: str = Field(default="room", max_length=16)
    start_number: int | None = Field(default=None, ge=0, le=99999)
    end_number: int | None = Field(default=None, ge=0, le=99999)
    values: str | None = Field(default=None, max_length=5000)
    seat_count: int = Field(default=2, ge=1, le=50)
    floor_id: int | None = None
    is_ordering_enabled: bool = True


class MenuModeUpdate(BaseModel):
    mode: str


class MenuOverrideUpdate(BaseModel):
    source: str = Field(pattern="^(tenant_product|product)$")
    enabled: bool | None = None
    price_cents_override: int | None = Field(default=None, ge=0)
    category_override: str | None = Field(default=None, max_length=120)
    sort_order_override: int | None = None
    available_from: date | None = None
    available_until: date | None = None


class LocationDateOverrideInput(BaseModel):
    override_date: date | None = None
    date_from: date | None = None
    date_to: date | None = None
    is_closed: bool = False
    opening_hours: dict | None = None
    ordering_hours: dict | None = None
    note: str | None = Field(default=None, max_length=240)


class LocationHoursUpdate(BaseModel):
    mode: str
    opening_hours_override: dict | None = None
    ordering_hours_override: dict | None = None
    date_overrides: list[LocationDateOverrideInput] = Field(default_factory=list, max_length=366)


class LocationPause(BaseModel):
    reason: str | None = Field(default=None, max_length=240)


class KitchenRoutingUpdate(BaseModel):
    mode: str
    default_kitchen_station_id: int | None = None


class PaymentRoutingUpdate(BaseModel):
    mode: str
    payment_account_reference: str | None = Field(default=None, max_length=128)


def _require_tenant_id(user: models.User) -> int:
    if user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Restaurant account required")
    return int(user.tenant_id)


def _validate_exception_hours(value: dict | None) -> None:
    if value is not None and ("open" in value or "close" in value or "closed" in value):
        validate_ordering_service_hours({"monday": value})
    else:
        validate_ordering_service_hours(value)


def _materialize_exception_hours(value: dict | None, selected_date: date) -> dict | None:
    if value is not None and ("open" in value or "close" in value or "closed" in value):
        return {_DAY_NAMES[selected_date.weekday()]: value}
    return value


def _normalise_location_input(body: LocationCreate | LocationUpdate) -> tuple[str | None, str | None, str | None, str | None]:
    name = body.name.strip() if body.name is not None else None
    display_name = body.display_name.strip() if body.display_name is not None else None
    slug = locations.slugify(body.slug or name or "") if body.slug is not None or name is not None else None
    location_type = body.location_type.strip().lower() if body.location_type is not None else None
    if location_type is not None and location_type not in locations.LOCATION_TYPES:
        raise HTTPException(status_code=400, detail="Invalid location type")
    return name, display_name, slug, location_type


def _assert_location_identity_available(
    session: Session,
    tenant_id: int,
    *,
    name: str,
    slug: str,
    exclude_id: int | None = None,
) -> None:
    rows = session.exec(
        select(models.TenantLocation).where(models.TenantLocation.tenant_id == tenant_id)
    ).all()
    if any(row.id != exclude_id and row.name.casefold() == name.casefold() for row in rows):
        raise HTTPException(status_code=409, detail="Location name already exists")
    if any(row.id != exclude_id and row.slug.casefold() == slug.casefold() for row in rows):
        raise HTTPException(status_code=409, detail="Location slug already exists")


def _create_location(
    session: Session,
    tenant_id: int,
    body: LocationCreate,
    actor_user_id: int | None,
) -> models.TenantLocation:
    name, display_name, slug, location_type = _normalise_location_input(body)
    assert name and display_name and slug and location_type
    _assert_location_identity_available(session, tenant_id, name=name, slug=slug)
    row = models.TenantLocation(
        tenant_id=tenant_id,
        name=name,
        display_name=display_name,
        slug=slug,
        location_type=location_type,
        sort_order=body.sort_order,
    )
    session.add(row)
    session.flush()
    locations.audit(
        session,
        tenant_id=tenant_id,
        location_id=row.id,
        action="location_created",
        actor_user_id=actor_user_id,
        detail={"name": row.name, "location_type": row.location_type},
    )
    session.commit()
    session.refresh(row)
    return row


def _update_location(
    session: Session,
    tenant_id: int,
    location_id: int,
    body: LocationUpdate,
    actor_user_id: int | None,
) -> models.TenantLocation:
    row = locations.get_location(session, tenant_id, location_id)
    name, display_name, slug, location_type = _normalise_location_input(body)
    next_name = name or row.name
    next_slug = slug or row.slug
    _assert_location_identity_available(
        session, tenant_id, name=next_name, slug=next_slug, exclude_id=row.id
    )
    before = row.model_dump(mode="json")
    if name is not None:
        row.name = name
    if display_name is not None:
        row.display_name = display_name
    if slug is not None:
        row.slug = slug
    if location_type is not None:
        row.location_type = location_type
    if body.is_active is not None:
        row.is_active = body.is_active
    if body.sort_order is not None:
        row.sort_order = body.sort_order
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    locations.audit(
        session,
        tenant_id=tenant_id,
        location_id=row.id,
        action="location_updated",
        actor_user_id=actor_user_id,
        detail={"before": before, "after": row.model_dump(mode="json")},
    )
    session.commit()
    session.refresh(row)
    return row


@router.get("/locations")
def list_locations(
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_READ))],
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    tenant_id = _require_tenant_id(current_user)
    rows = session.exec(
        select(models.TenantLocation)
        .where(models.TenantLocation.tenant_id == tenant_id)
        .order_by(models.TenantLocation.sort_order, models.TenantLocation.id)
    ).all()
    return [locations.serialize_location(session, row) for row in rows]


@router.get("/operational-locations")
def list_operational_locations(
    current_user: Annotated[models.User, Depends(require_permission(Permission.ORDER_READ))],
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    tenant_id = _require_tenant_id(current_user)
    rows = session.exec(
        select(models.TenantLocation)
        .where(models.TenantLocation.tenant_id == tenant_id)
        .order_by(models.TenantLocation.sort_order, models.TenantLocation.id)
    ).all()
    return [
        {
            "id": row.id,
            "display_name": row.display_name,
            "location_type": row.location_type,
            "is_active": row.is_active,
        }
        for row in rows
    ]


@router.post("/locations", status_code=status.HTTP_201_CREATED)
def create_location(
    body: LocationCreate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    row = _create_location(session, _require_tenant_id(current_user), body, current_user.id)
    return locations.serialize_location(session, row)


@router.get("/locations/{location_id}")
def get_location_detail(
    location_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_READ))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    row = locations.get_location(session, _require_tenant_id(current_user), location_id)
    return locations.serialize_location(session, row)


@router.patch("/locations/{location_id}")
def update_location(
    location_id: int,
    body: LocationUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    row = _update_location(
        session, _require_tenant_id(current_user), location_id, body, current_user.id
    )
    return locations.serialize_location(session, row)


@router.post("/locations/{location_id}/archive")
def archive_location(
    location_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    row = locations.get_location(session, tenant_id, location_id)
    active_locations = session.exec(
        select(models.TenantLocation).where(
            models.TenantLocation.tenant_id == tenant_id,
            models.TenantLocation.is_active == True,  # noqa: E712
        )
    ).all()
    if row.is_active and len(active_locations) <= 1:
        raise HTTPException(status_code=409, detail="A restaurant must retain one active location")
    row.is_active = False
    row.ordering_paused = True
    row.ordering_pause_reason = "This location is currently unavailable."
    row.updated_at = datetime.now(timezone.utc)
    points = session.exec(
        select(models.Table).where(models.Table.location_id == row.id)
    ).all()
    for point in points:
        point.is_ordering_enabled = False
        session.add(point)
    session.add(row)
    locations.audit(
        session,
        tenant_id=tenant_id,
        location_id=row.id,
        action="location_archived",
        actor_user_id=current_user.id,
        detail={"disabled_ordering_points": len(points)},
    )
    session.commit()
    return locations.serialize_location(session, row)


def _point_dict(session: Session, point: models.Table) -> dict[str, Any]:
    _location, context = locations.location_context(session, point)
    row = point.model_dump(mode="json")
    row.update(context)
    plaque = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.table_id == point.id)
    ).first()
    row["smart_plaque_id"] = plaque.id if plaque else None
    row["smart_plaque_code"] = plaque.public_code if plaque else None
    return row


@router.get("/locations/{location_id}/ordering-points")
def list_ordering_points(
    location_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_READ))],
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    tenant_id = _require_tenant_id(current_user)
    locations.get_location(session, tenant_id, location_id)
    rows = session.exec(
        select(models.Table)
        .where(models.Table.location_id == location_id, models.Table.tenant_id == tenant_id)
        .order_by(models.Table.service_point_type, models.Table.display_number, models.Table.id)
    ).all()
    return [_point_dict(session, row) for row in rows]


def _validate_point_input(
    session: Session,
    tenant_id: int,
    location: models.TenantLocation,
    point_type: str,
    display_number: str,
    *,
    exclude_id: int | None = None,
) -> str:
    kind = point_type.strip().lower()
    if kind not in locations.SERVICE_POINT_TYPES:
        raise HTTPException(status_code=400, detail="Ordering point type must be table or room")
    number = display_number.strip()
    if not number:
        raise HTTPException(status_code=400, detail="Display number is required")
    rows = session.exec(
        select(models.Table).where(
            models.Table.tenant_id == tenant_id,
            models.Table.location_id == location.id,
        )
    ).all()
    if any(
        row.id != exclude_id and (row.display_number or "").casefold() == number.casefold()
        for row in rows
    ):
        raise HTTPException(status_code=409, detail=f"Ordering point already exists: {number}")
    return kind


@router.post("/locations/{location_id}/ordering-points", status_code=status.HTTP_201_CREATED)
def create_ordering_point(
    location_id: int,
    body: PointCreate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    if not location.is_active and body.is_ordering_enabled:
        raise HTTPException(status_code=409, detail="Activate the location before enabling ordering")
    kind = _validate_point_input(
        session, tenant_id, location, body.service_point_type, body.display_number
    )
    if body.is_ordering_enabled:
        locations.ensure_point_capacity(session, tenant_id, additional_active=1)
    if body.floor_id is not None:
        floor = session.get(models.Floor, body.floor_id)
        if floor is None or floor.tenant_id != tenant_id:
            raise HTTPException(status_code=400, detail="Floor does not belong to this tenant")
    prefix = "Room" if kind == "room" else "Table"
    point = models.Table(
        tenant_id=tenant_id,
        location_id=location.id,
        service_point_type=kind,
        display_number=body.display_number.strip(),
        name=(body.name or f"{prefix} {body.display_number.strip()}").strip(),
        customer_label=(body.customer_label or "").strip() or None,
        seat_count=body.seat_count,
        floor_id=body.floor_id,
        is_ordering_enabled=body.is_ordering_enabled,
    )
    session.add(point)
    session.flush()
    locations.audit(
        session,
        tenant_id=tenant_id,
        location_id=location.id,
        table_id=point.id,
        action="ordering_point_created",
        actor_user_id=current_user.id,
        detail={"type": kind, "display_number": point.display_number, "enabled": point.is_ordering_enabled},
    )
    session.commit()
    session.refresh(point)
    return _point_dict(session, point)


def _bulk_values(body: PointBulkCreate) -> list[str]:
    if body.service_point_type not in locations.SERVICE_POINT_TYPES:
        raise HTTPException(status_code=400, detail="Ordering point type must be table or room")
    if body.values and body.values.strip():
        values = [part.strip() for part in re.split(r"[,\n\r]+", body.values) if part.strip()]
    elif body.start_number is not None and body.end_number is not None:
        if body.end_number < body.start_number:
            raise HTTPException(status_code=400, detail="End number must be at least the start number")
        if body.end_number - body.start_number + 1 > 500:
            raise HTTPException(status_code=400, detail="Bulk creation is limited to 500 points")
        values = [str(number) for number in range(body.start_number, body.end_number + 1)]
    else:
        raise HTTPException(status_code=400, detail="Provide a number range or comma/newline list")
    if not values or len(values) > 500:
        raise HTTPException(status_code=400, detail="Bulk creation requires 1 to 500 points")
    return values


def _bulk_preview(
    session: Session,
    tenant_id: int,
    location: models.TenantLocation,
    body: PointBulkCreate,
) -> dict[str, Any]:
    values = _bulk_values(body)
    seen: set[str] = set()
    duplicate_inputs: list[str] = []
    for value in values:
        key = value.casefold()
        if key in seen:
            duplicate_inputs.append(value)
        seen.add(key)
    existing = session.exec(
        select(models.Table).where(models.Table.location_id == location.id)
    ).all()
    existing_numbers = {(row.display_number or "").casefold() for row in existing}
    conflicts = [value for value in values if value.casefold() in existing_numbers]
    tenant = session.get(models.Tenant, tenant_id)
    current = locations.active_point_usage(session, tenant_id)
    limit = tenant_table_limit(tenant)
    active_new = len(values) if body.is_ordering_enabled else 0
    prefix = "Room" if body.service_point_type == "room" else "Table"
    return {
        "labels": [f"{prefix} {value}" for value in values],
        "display_numbers": values,
        "duplicate_inputs": duplicate_inputs,
        "conflicts": conflicts,
        "new_ordering_points": len(values),
        "active_new_ordering_points": active_new,
        "current_usage": current,
        "ordering_point_limit": limit,
        "post_create_usage": current + active_new,
        "available_after": max(0, limit - current - active_new),
        "allowed": not duplicate_inputs and not conflicts and current + active_new <= limit,
    }


@router.post("/locations/{location_id}/ordering-points/bulk/preview")
def preview_bulk_ordering_points(
    location_id: int,
    body: PointBulkCreate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    return _bulk_preview(session, tenant_id, location, body)


@router.post("/locations/{location_id}/ordering-points/bulk", status_code=status.HTTP_201_CREATED)
def bulk_create_ordering_points(
    location_id: int,
    body: PointBulkCreate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    preview = _bulk_preview(session, tenant_id, location, body)
    if preview["duplicate_inputs"]:
        raise HTTPException(status_code=400, detail={"code": "duplicate_input", **preview})
    if preview["conflicts"]:
        raise HTTPException(status_code=409, detail={"code": "ordering_point_conflict", **preview})
    if body.is_ordering_enabled:
        locations.ensure_point_capacity(
            session, tenant_id, additional_active=preview["active_new_ordering_points"]
        )
    if not location.is_active and body.is_ordering_enabled:
        raise HTTPException(status_code=409, detail="Activate the location before enabling ordering")
    if body.floor_id is not None:
        floor = session.get(models.Floor, body.floor_id)
        if floor is None or floor.tenant_id != tenant_id:
            raise HTTPException(status_code=400, detail="Floor does not belong to this tenant")
    prefix = "Room" if body.service_point_type == "room" else "Table"
    rows = [
        models.Table(
            tenant_id=tenant_id,
            location_id=location.id,
            service_point_type=body.service_point_type,
            display_number=value,
            name=f"{prefix} {value}",
            seat_count=body.seat_count,
            floor_id=body.floor_id,
            is_ordering_enabled=body.is_ordering_enabled,
        )
        for value in preview["display_numbers"]
    ]
    session.add_all(rows)
    session.flush()
    locations.audit(
        session,
        tenant_id=tenant_id,
        location_id=location.id,
        action="ordering_points_bulk_created",
        actor_user_id=current_user.id,
        detail={"count": len(rows), "type": body.service_point_type, "enabled": body.is_ordering_enabled},
    )
    session.commit()
    for row in rows:
        session.refresh(row)
    return {"preview": preview, "ordering_points": [_point_dict(session, row) for row in rows]}


@router.patch("/locations/{location_id}/ordering-points/{point_id}")
def update_ordering_point(
    location_id: int,
    point_id: int,
    body: PointUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.TABLE_WRITE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    source_location = locations.get_location(session, tenant_id, location_id)
    point = session.exec(
        select(models.Table).where(
            models.Table.id == point_id,
            models.Table.tenant_id == tenant_id,
            models.Table.location_id == source_location.id,
        )
    ).first()
    if point is None:
        raise HTTPException(status_code=404, detail="Ordering point not found")
    target_location = (
        locations.get_location(session, tenant_id, body.location_id)
        if body.location_id is not None
        else source_location
    )
    next_type = body.service_point_type or point.service_point_type
    next_number = (body.display_number or point.display_number or point.name).strip()
    _validate_point_input(
        session,
        tenant_id,
        target_location,
        next_type,
        next_number,
        exclude_id=point.id,
    )
    if body.is_ordering_enabled is True and not point.is_ordering_enabled:
        locations.ensure_point_capacity(session, tenant_id, additional_active=1)
    if body.is_ordering_enabled is True and not target_location.is_active:
        raise HTTPException(status_code=409, detail="Activate the location before enabling ordering")
    if body.floor_id is not None:
        floor = session.get(models.Floor, body.floor_id)
        if floor is None or floor.tenant_id != tenant_id:
            raise HTTPException(status_code=400, detail="Floor does not belong to this tenant")
    before = {
        "location_id": point.location_id,
        "service_point_type": point.service_point_type,
        "display_number": point.display_number,
        "seat_count": point.seat_count,
        "is_ordering_enabled": point.is_ordering_enabled,
    }
    point.location_id = target_location.id
    point.service_point_type = next_type
    point.display_number = next_number
    if body.name is not None:
        point.name = body.name.strip()
    if body.customer_label is not None:
        point.customer_label = body.customer_label.strip() or None
    if body.seat_count is not None:
        point.seat_count = body.seat_count
    if body.floor_id is not None:
        point.floor_id = body.floor_id
    if body.is_ordering_enabled is not None:
        point.is_ordering_enabled = body.is_ordering_enabled
    session.add(point)
    session.flush()
    if before["location_id"] != point.location_id:
        # Stale baskets and hidden direct table tokens cannot continue after a physical move.
        point.token = __import__("uuid").uuid4().hex
        point.token_rotated_at = datetime.now(timezone.utc)
        session.add(point)
    locations.audit(
        session,
        tenant_id=tenant_id,
        location_id=target_location.id,
        table_id=point.id,
        action="ordering_point_updated",
        actor_user_id=current_user.id,
        detail={
            "before": before,
            "after": {
                "location_id": point.location_id,
                "service_point_type": point.service_point_type,
                "display_number": point.display_number,
                "seat_count": point.seat_count,
                "is_ordering_enabled": point.is_ordering_enabled,
            },
        },
    )
    session.commit()
    session.refresh(point)
    return _point_dict(session, point)


@router.get("/locations/{location_id}/menu")
def get_location_menu(
    location_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.PRODUCT_READ))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    overrides = session.exec(
        select(models.LocationMenuProduct).where(
            models.LocationMenuProduct.location_id == location.id,
            models.LocationMenuProduct.tenant_id == tenant_id,
        )
    ).all()
    override_tp = {row.tenant_product_id: row for row in overrides if row.tenant_product_id}
    override_product = {row.product_id: row for row in overrides if row.product_id}
    tenant_products = session.exec(
        select(models.TenantProduct).where(models.TenantProduct.tenant_id == tenant_id)
    ).all()
    linked = {row.product_id for row in tenant_products if row.product_id is not None}
    legacy = session.exec(
        select(models.Product).where(models.Product.tenant_id == tenant_id)
    ).all()
    rows: list[dict[str, Any]] = []
    for product in tenant_products:
        override = override_tp.get(product.id)
        rows.append({
            "id": product.id,
            "source": "tenant_product",
            "name": product.name,
            "price_cents": product.price_cents,
            "master_enabled": product.is_active,
            "override": override.model_dump(mode="json") if override else None,
        })
    for product in legacy:
        if product.id in linked:
            continue
        override = override_product.get(product.id)
        rows.append({
            "id": product.id,
            "source": "product",
            "name": product.name,
            "price_cents": product.price_cents,
            "master_enabled": product.is_available,
            "override": override.model_dump(mode="json") if override else None,
        })
    return {"location_id": location.id, "menu_mode": location.menu_mode, "products": rows}


@router.put("/locations/{location_id}/menu-mode")
def update_location_menu_mode(
    location_id: int,
    body: MenuModeUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.PRODUCT_WRITE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    mode = body.mode.strip().lower()
    if mode not in locations.INHERITANCE_MODES:
        raise HTTPException(status_code=400, detail="Mode must be inherit or override")
    location.menu_mode = mode
    location.updated_at = datetime.now(timezone.utc)
    session.add(location)
    locations.audit(session, tenant_id=tenant_id, location_id=location.id, action="menu_mode_changed", actor_user_id=current_user.id, detail={"mode": mode})
    session.commit()
    return {"location_id": location.id, "menu_mode": mode}


@router.put("/locations/{location_id}/menu/{item_id}")
def update_location_menu_product(
    location_id: int,
    item_id: int,
    body: MenuOverrideUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.PRODUCT_WRITE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    if body.available_from and body.available_until and body.available_from > body.available_until:
        raise HTTPException(status_code=400, detail="available_from must not be after available_until")
    if body.source == "tenant_product":
        product = session.exec(select(models.TenantProduct).where(models.TenantProduct.id == item_id, models.TenantProduct.tenant_id == tenant_id)).first()
        if product is None:
            raise HTTPException(status_code=404, detail="Menu product not found")
        override = session.exec(select(models.LocationMenuProduct).where(models.LocationMenuProduct.location_id == location.id, models.LocationMenuProduct.tenant_product_id == item_id)).first()
    else:
        product = session.exec(select(models.Product).where(models.Product.id == item_id, models.Product.tenant_id == tenant_id)).first()
        if product is None:
            raise HTTPException(status_code=404, detail="Product not found")
        override = session.exec(select(models.LocationMenuProduct).where(models.LocationMenuProduct.location_id == location.id, models.LocationMenuProduct.product_id == item_id)).first()
    if override is None:
        override = models.LocationMenuProduct(
            tenant_id=tenant_id,
            location_id=location.id,
            tenant_product_id=item_id if body.source == "tenant_product" else None,
            product_id=item_id if body.source == "product" else None,
        )
    for field_name, value in body.model_dump(exclude={"source"}).items():
        setattr(override, field_name, value)
    override.updated_at = datetime.now(timezone.utc)
    session.add(override)
    location.menu_mode = "override"
    session.add(location)
    session.flush()
    locations.audit(session, tenant_id=tenant_id, location_id=location.id, action="menu_override_updated", actor_user_id=current_user.id, detail={"source": body.source, "item_id": item_id, "enabled": body.enabled, "price_cents_override": body.price_cents_override})
    session.commit()
    session.refresh(override)
    return override.model_dump(mode="json")


@router.get("/locations/{location_id}/hours")
def get_location_hours(
    location_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_READ))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    tenant = session.get(models.Tenant, tenant_id)
    exceptions = session.exec(select(models.LocationDateOverride).where(models.LocationDateOverride.location_id == location.id).order_by(models.LocationDateOverride.override_date)).all()
    return {
        "hours_mode": location.hours_mode,
        "opening_hours_override": location.opening_hours_override,
        "ordering_hours_override": location.ordering_hours_override,
        "effective_opening_hours": locations.effective_hours(tenant, location, kind="opening"),
        "effective_ordering_hours": locations.effective_hours(tenant, location, kind="ordering"),
        "date_overrides": [row.model_dump(mode="json") for row in exceptions],
    }


@router.put("/locations/{location_id}/hours")
def update_location_hours(
    location_id: int,
    body: LocationHoursUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    mode = body.mode.strip().lower()
    if mode not in locations.INHERITANCE_MODES:
        raise HTTPException(status_code=400, detail="Mode must be inherit or override")
    try:
        validate_ordering_service_hours(body.opening_hours_override)
        validate_ordering_service_hours(body.ordering_hours_override)
        for exception in body.date_overrides:
            _validate_exception_hours(exception.opening_hours)
            _validate_exception_hours(exception.ordering_hours)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    expanded_overrides: dict[date, LocationDateOverrideInput] = {}
    for item in body.date_overrides:
        if item.override_date is not None:
            dates = [item.override_date]
        elif item.date_from is not None and item.date_to is not None:
            if item.date_to < item.date_from:
                raise HTTPException(status_code=400, detail="Date override end must not precede start")
            if (item.date_to - item.date_from).days > 365:
                raise HTTPException(status_code=400, detail="Date override range is limited to 366 days")
            dates = [
                item.date_from + timedelta(days=offset)
                for offset in range((item.date_to - item.date_from).days + 1)
            ]
        else:
            raise HTTPException(status_code=400, detail="Date override requires override_date or date_from/date_to")
        for selected_date in dates:
            expanded_overrides[selected_date] = item
    location.hours_mode = mode
    location.opening_hours_override = body.opening_hours_override if mode == "override" else None
    location.ordering_hours_override = body.ordering_hours_override if mode == "override" else None
    location.updated_at = datetime.now(timezone.utc)
    session.add(location)
    existing = session.exec(select(models.LocationDateOverride).where(models.LocationDateOverride.location_id == location.id)).all()
    by_date = {row.override_date: row for row in existing}
    requested_dates = set(expanded_overrides)
    for old in existing:
        if old.override_date not in requested_dates:
            session.delete(old)
    for selected_date, item in expanded_overrides.items():
        row = by_date.get(selected_date) or models.LocationDateOverride(tenant_id=tenant_id, location_id=location.id, override_date=selected_date)
        row.is_closed = item.is_closed
        row.opening_hours = _materialize_exception_hours(item.opening_hours, selected_date)
        row.ordering_hours = _materialize_exception_hours(item.ordering_hours, selected_date)
        row.note = item.note
        session.add(row)
    locations.audit(session, tenant_id=tenant_id, location_id=location.id, action="hours_updated", actor_user_id=current_user.id, detail={"mode": mode, "date_override_count": len(expanded_overrides)})
    session.commit()
    return get_location_hours(location_id, current_user, session)


@router.post("/locations/{location_id}/pause")
def pause_location(
    location_id: int,
    body: LocationPause,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    location.ordering_paused = True
    location.ordering_pause_reason = (body.reason or "Ordering is temporarily paused at this location.").strip()
    location.updated_at = datetime.now(timezone.utc)
    session.add(location)
    locations.audit(session, tenant_id=tenant_id, location_id=location.id, action="location_paused", actor_user_id=current_user.id, detail={"reason": location.ordering_pause_reason})
    session.commit()
    return {"ordering_paused": True, "ordering_pause_reason": location.ordering_pause_reason}


@router.post("/locations/{location_id}/resume")
def resume_location(
    location_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    location.ordering_paused = False
    location.ordering_pause_reason = None
    location.updated_at = datetime.now(timezone.utc)
    session.add(location)
    locations.audit(session, tenant_id=tenant_id, location_id=location.id, action="location_resumed", actor_user_id=current_user.id)
    session.commit()
    return {"ordering_paused": False, "ordering_pause_reason": None}


@router.get("/locations/{location_id}/routing")
def get_location_routing(
    location_id: int,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_READ))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    tenant = session.get(models.Tenant, tenant_id)
    return {
        "kitchen_mode": location.kitchen_mode,
        "default_kitchen_station_id": location.default_kitchen_station_id,
        "resolved_kitchen_station_id": locations.resolved_kitchen_station_id(tenant, location),
        "payment_mode": location.payment_mode,
        "payment_account_reference": location.payment_account_reference,
        "resolved_payment_account": locations.payment_account_snapshot(tenant, location),
        "payment_override_enabled": settings.location_payment_override_enabled,
    }


@router.put("/locations/{location_id}/kitchen-routing")
def update_location_kitchen_routing(
    location_id: int,
    body: KitchenRoutingUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    mode = body.mode.strip().lower()
    if mode not in locations.INHERITANCE_MODES:
        raise HTTPException(status_code=400, detail="Mode must be inherit or override")
    locations.validate_station(session, tenant_id, body.default_kitchen_station_id)
    if mode == "override" and body.default_kitchen_station_id is None:
        raise HTTPException(status_code=400, detail="Choose a kitchen station for override mode")
    location.kitchen_mode = mode
    location.default_kitchen_station_id = body.default_kitchen_station_id if mode == "override" else None
    location.updated_at = datetime.now(timezone.utc)
    session.add(location)
    locations.audit(session, tenant_id=tenant_id, location_id=location.id, action="kitchen_routing_updated", actor_user_id=current_user.id, detail={"mode": mode, "station_id": location.default_kitchen_station_id})
    session.commit()
    return get_location_routing(location_id, current_user, session)


@router.put("/locations/{location_id}/payment-routing")
def update_location_payment_routing(
    location_id: int,
    body: PaymentRoutingUpdate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.SETTINGS_BILLING))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    location = locations.get_location(session, tenant_id, location_id)
    mode = body.mode.strip().lower()
    if mode not in locations.INHERITANCE_MODES:
        raise HTTPException(status_code=400, detail="Mode must be inherit or override")
    if mode == "override" and not settings.location_payment_override_enabled:
        raise HTTPException(status_code=409, detail="Location-specific payment accounts are not enabled")
    reference = (body.payment_account_reference or "").strip() or None
    if mode == "override" and not reference:
        raise HTTPException(status_code=400, detail="Payment account reference is required")
    location.payment_mode = mode
    location.payment_account_reference = reference if mode == "override" else None
    location.updated_at = datetime.now(timezone.utc)
    session.add(location)
    locations.audit(session, tenant_id=tenant_id, location_id=location.id, action="payment_routing_updated", actor_user_id=current_user.id, detail={"mode": mode, "reference": reference})
    session.commit()
    return get_location_routing(location_id, current_user, session)


@router.get("/location-analytics/summary")
def location_analytics(
    current_user: Annotated[models.User, Depends(require_permission(Permission.REPORT_READ))],
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    location_id: int | None = Query(default=None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    tenant_id = _require_tenant_id(current_user)
    if location_id is not None:
        locations.get_location(session, tenant_id, location_id)
    start = from_date or date(1970, 1, 1)
    end = to_date or date.today()
    orders = session.exec(
        select(models.Order).where(
            models.Order.tenant_id == tenant_id,
            models.Order.deleted_at.is_(None),
        )
    ).all()
    orders = [order for order in orders if start <= (order.paid_at or order.created_at).date() <= end]
    if location_id is not None:
        orders = [order for order in orders if order.location_id == location_id]
    location_rows = session.exec(select(models.TenantLocation).where(models.TenantLocation.tenant_id == tenant_id)).all()
    names = {row.id: row.display_name for row in location_rows}
    grouped: dict[int | None, dict[str, Any]] = {}
    point_counts: dict[tuple[int | None, str], int] = {}
    for order in orders:
        key = order.location_id
        group = grouped.setdefault(key, {"location_id": key, "location_name": order.location_name_snapshot or names.get(key) or "Legacy", "order_ids": set(), "gross_sales_cents": 0, "failed_or_cancelled": 0, "refund_count": 0, "prep_seconds_total": 0, "prep_sample_count": 0})
        if order.payment_state in {"refunded", "partially_refunded"}:
            group["refund_count"] += 1
        if order.status == models.OrderStatus.cancelled or order.payment_state in {"failed", "cancelled"}:
            group["failed_or_cancelled"] += 1
            continue
        if order.status not in {models.OrderStatus.paid, models.OrderStatus.completed} and order.paid_at is None:
            continue
        items = session.exec(select(models.OrderItem).where(models.OrderItem.order_id == order.id, models.OrderItem.removed_by_customer == False, models.OrderItem.status != models.OrderItemStatus.cancelled)).all()  # noqa: E712
        gross = sum(item.price_cents * item.quantity for item in items) + int(order.tip_amount_cents or 0)
        group["order_ids"].add(order.id)
        group["gross_sales_cents"] += gross
        completed_times = [item.status_updated_at for item in items if item.status_updated_at]
        if order.kitchen_released_at and completed_times:
            released_at = order.kitchen_released_at
            if released_at.tzinfo is None:
                released_at = released_at.replace(tzinfo=timezone.utc)
            completed_at = max(
                value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
                for value in completed_times
            )
            prep_seconds = max(0, int((completed_at - released_at).total_seconds()))
            group["prep_seconds_total"] += prep_seconds
            group["prep_sample_count"] += 1
        point_key = (key, order.service_point_label_snapshot or "Unknown")
        point_counts[point_key] = point_counts.get(point_key, 0) + 1
    output = []
    for group in grouped.values():
        count = len(group.pop("order_ids"))
        group["order_count"] = count
        group["average_order_value_cents"] = round(group["gross_sales_cents"] / count) if count else 0
        group["average_kitchen_prep_seconds"] = (
            round(group.pop("prep_seconds_total") / group["prep_sample_count"])
            if group["prep_sample_count"] else None
        )
        group.pop("prep_sample_count", None)
        output.append(group)
    output.sort(key=lambda row: (row["location_name"], row["location_id"] or 0))
    total_orders = sum(row["order_count"] for row in output)
    total_sales = sum(row["gross_sales_cents"] for row in output)
    tenant = session.get(models.Tenant, tenant_id)
    used = locations.active_point_usage(session, tenant_id)
    limit = tenant_table_limit(tenant)
    return {
        "combined": {"order_count": total_orders, "gross_sales_cents": total_sales, "average_order_value_cents": round(total_sales / total_orders) if total_orders else 0},
        "by_location": output,
        "busiest_ordering_points": [
            {"location_id": key[0], "service_point_label": key[1], "order_count": count}
            for key, count in sorted(point_counts.items(), key=lambda item: -item[1])[:20]
        ],
        "active_ordering_points": used,
        "ordering_point_limit": limit,
        "ordering_points_available": max(0, limit - used),
    }


# Platform CRM access uses explicit tenant path and platform role, never a body tenant_id.
@router.get("/platform/tenants/{tenant_id}/locations")
def platform_list_locations(
    tenant_id: int,
    current_user: Annotated[models.User, Depends(require_role(models.UserRole.platform_operator))],
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    if session.get(models.Tenant, tenant_id) is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    rows = session.exec(select(models.TenantLocation).where(models.TenantLocation.tenant_id == tenant_id).order_by(models.TenantLocation.sort_order, models.TenantLocation.id)).all()
    return [locations.serialize_location(session, row) for row in rows]


@router.post("/platform/tenants/{tenant_id}/locations", status_code=status.HTTP_201_CREATED)
def platform_create_location(
    tenant_id: int,
    body: LocationCreate,
    current_user: Annotated[models.User, Depends(require_role(models.UserRole.platform_operator))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if session.get(models.Tenant, tenant_id) is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    row = _create_location(session, tenant_id, body, current_user.id)
    return locations.serialize_location(session, row)


@router.patch("/platform/tenants/{tenant_id}/locations/{location_id}")
def platform_update_location(
    tenant_id: int,
    location_id: int,
    body: LocationUpdate,
    current_user: Annotated[models.User, Depends(require_role(models.UserRole.platform_operator))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    row = _update_location(session, tenant_id, location_id, body, current_user.id)
    return locations.serialize_location(session, row)


@router.post("/platform/tenants/{tenant_id}/locations/{location_id}/archive")
def platform_archive_location(
    tenant_id: int,
    location_id: int,
    current_user: Annotated[models.User, Depends(require_role(models.UserRole.platform_operator))],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    row = locations.get_location(session, tenant_id, location_id)
    active_locations = session.exec(
        select(models.TenantLocation).where(
            models.TenantLocation.tenant_id == tenant_id,
            models.TenantLocation.is_active == True,  # noqa: E712
        )
    ).all()
    if row.is_active and len(active_locations) <= 1:
        raise HTTPException(status_code=409, detail="A restaurant must retain one active location")
    row.is_active = False
    row.ordering_paused = True
    row.ordering_pause_reason = "This location is currently unavailable."
    points = session.exec(select(models.Table).where(models.Table.location_id == row.id)).all()
    for point in points:
        point.is_ordering_enabled = False
        session.add(point)
    session.add(row)
    locations.audit(
        session,
        tenant_id=tenant_id,
        location_id=row.id,
        action="location_archived_by_platform",
        actor_user_id=current_user.id,
        detail={"disabled_ordering_points": len(points)},
    )
    session.commit()
    return locations.serialize_location(session, row)
