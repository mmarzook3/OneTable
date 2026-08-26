"""Tenant-safe multi-location resolution shared by ordering, KDS and CRM."""

from __future__ import annotations

from datetime import date, datetime, timezone
import json
import re
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlmodel import Session, select

from . import models
from .saas_billing import plan_has_unlimited_ordering_points, tenant_table_limit


LOCATION_TYPES = {"pub", "lounge", "hotel_building", "other"}
INHERITANCE_MODES = {"inherit", "override"}
SERVICE_POINT_TYPES = {"table", "room"}


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "location"


def display_number_from_name(name: str) -> str:
    value = re.sub(r"^(table|room)\s*", "", name.strip(), flags=re.IGNORECASE).strip()
    return value or name.strip()


def service_point_label(point: models.Table) -> str:
    explicit = (point.customer_label or "").strip()
    if explicit:
        return explicit
    number = (point.display_number or display_number_from_name(point.name)).strip()
    prefix = "Room" if point.service_point_type == "room" else "Table"
    return f"{prefix} {number}"


def get_location(
    session: Session,
    tenant_id: int,
    location_id: int | None,
    *,
    required: bool = True,
) -> models.TenantLocation | None:
    if location_id is None:
        location = session.exec(
            select(models.TenantLocation)
            .where(models.TenantLocation.tenant_id == tenant_id)
            .order_by(models.TenantLocation.sort_order, models.TenantLocation.id)
        ).first()
    else:
        location = session.exec(
            select(models.TenantLocation).where(
                models.TenantLocation.id == location_id,
                models.TenantLocation.tenant_id == tenant_id,
            )
        ).first()
    if required and location is None:
        raise HTTPException(status_code=404, detail="Location not found")
    return location


def validate_station(session: Session, tenant_id: int, station_id: int | None) -> None:
    if station_id is None:
        return
    station = session.get(models.KitchenStation, station_id)
    if station is None or station.tenant_id != tenant_id:
        raise HTTPException(status_code=400, detail="Kitchen station does not belong to this tenant")


def audit(
    session: Session,
    *,
    tenant_id: int,
    action: str,
    actor_user_id: int | None,
    location_id: int | None = None,
    table_id: int | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    session.add(
        models.LocationAuditEvent(
            tenant_id=tenant_id,
            location_id=location_id,
            table_id=table_id,
            action=action,
            actor_user_id=actor_user_id,
            detail=detail or None,
        )
    )


def active_point_usage(session: Session, tenant_id: int) -> int:
    return int(
        session.exec(
            select(func.count())
            .select_from(models.Table)
            .where(
                models.Table.tenant_id == tenant_id,
                models.Table.is_ordering_enabled == True,  # noqa: E712
            )
        ).one()
        or 0
    )


def ensure_point_capacity(
    session: Session,
    tenant_id: int,
    *,
    additional_active: int,
) -> tuple[int, int]:
    tenant = session.get(models.Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    current = active_point_usage(session, tenant_id)
    limit = tenant_table_limit(tenant)
    if current + max(0, additional_active) > limit:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "ordering_point_plan_limit",
                "message": (
                    f"Your {tenant.saas_plan_code.title()} plan allows {limit} active ordering points."
                ),
                "current_ordering_points": current,
                "ordering_point_limit": limit,
                "additional_required": max(0, current + additional_active - limit),
            },
        )
    return current, limit


def serialize_location(session: Session, location: models.TenantLocation) -> dict[str, Any]:
    points = session.exec(
        select(models.Table).where(models.Table.location_id == location.id)
    ).all()
    point_ids = [int(point.id) for point in points if point.id is not None]
    plaque_count = 0
    if point_ids:
        plaque_count = int(
            session.exec(
                select(func.count())
                .select_from(models.SmartPlaque)
                .where(models.SmartPlaque.table_id.in_(point_ids))
            ).one()
            or 0
        )
    tenant = session.get(models.Tenant, location.tenant_id)
    used = active_point_usage(session, location.tenant_id)
    limit = tenant_table_limit(tenant) if tenant else 0
    row = location.model_dump(mode="json")
    row.update(
        ordering_point_count=len(points),
        active_ordering_point_count=sum(1 for p in points if p.is_ordering_enabled),
        table_count=sum(1 for p in points if p.service_point_type == "table"),
        room_count=sum(1 for p in points if p.service_point_type == "room"),
        assigned_plaque_count=plaque_count,
        unassigned_plaque_count=max(0, len(points) - plaque_count),
        ordering_point_usage=used,
        ordering_point_limit=limit,
        ordering_points_unlimited=(
            plan_has_unlimited_ordering_points(tenant.saas_plan_code)
            if tenant else False
        ),
        ordering_points_available=max(0, limit - used),
        readiness={
            "identity": bool(location.display_name.strip()),
            "menu": location.menu_mode == "inherit" or True,
            "hours": location.hours_mode == "inherit" or bool(location.ordering_hours_override),
            "kitchen": location.kitchen_mode == "inherit" or location.default_kitchen_station_id is not None,
            "payment": location.payment_mode == "inherit" or bool(location.payment_account_reference),
            "plaques": len(points) == 0 or plaque_count == len(points),
        },
    )
    return row


def location_context(
    session: Session,
    point: models.Table,
) -> tuple[models.TenantLocation | None, dict[str, Any]]:
    location = get_location(session, point.tenant_id, point.location_id, required=False)
    label = service_point_label(point)
    display_name = location.display_name if location else ""
    return location, {
        "location_id": location.id if location else None,
        "location_name": display_name,
        "location_type": location.location_type if location else None,
        "service_point_type": point.service_point_type or "table",
        "service_point_number": point.display_number or display_number_from_name(point.name),
        "service_point_label": label,
        "ordering_context_label": f"Ordering from {display_name} - {label}" if display_name else f"Ordering from {label}",
        "ordering_point_assignment_version": int(point.assignment_version or 1),
    }


def effective_hours(
    tenant: models.Tenant,
    location: models.TenantLocation | None,
    *,
    kind: str,
) -> dict[str, Any] | None:
    if kind not in {"opening", "ordering"}:
        raise ValueError("kind must be opening or ordering")
    if location and location.hours_mode == "override":
        selected = (
            location.opening_hours_override
            if kind == "opening"
            else location.ordering_hours_override
        )
        if selected is not None:
            return selected
    if kind == "ordering" and tenant.ordering_service_hours is not None:
        return tenant.ordering_service_hours
    raw = tenant.opening_hours
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (TypeError, ValueError):
        return None


def date_override(
    session: Session,
    location: models.TenantLocation | None,
    on_date: date,
) -> models.LocationDateOverride | None:
    if location is None:
        return None
    return session.exec(
        select(models.LocationDateOverride).where(
            models.LocationDateOverride.location_id == location.id,
            models.LocationDateOverride.override_date == on_date,
        )
    ).first()


def menu_override_maps(
    session: Session,
    location: models.TenantLocation | None,
) -> tuple[dict[int, models.LocationMenuProduct], dict[int, models.LocationMenuProduct]]:
    if location is None or location.menu_mode != "override":
        return {}, {}
    rows = session.exec(
        select(models.LocationMenuProduct).where(
            models.LocationMenuProduct.location_id == location.id,
            models.LocationMenuProduct.tenant_id == location.tenant_id,
        )
    ).all()
    by_tenant_product = {
        int(row.tenant_product_id): row for row in rows if row.tenant_product_id is not None
    }
    by_product = {int(row.product_id): row for row in rows if row.product_id is not None}
    return by_tenant_product, by_product


def apply_menu_override(
    product_data: dict[str, Any],
    override: models.LocationMenuProduct | None,
    *,
    today: date,
) -> bool:
    if override is None:
        return True
    if override.enabled is False:
        return False
    if override.available_from and today < override.available_from:
        return False
    if override.available_until and today > override.available_until:
        return False
    if override.price_cents_override is not None:
        product_data["price_cents"] = override.price_cents_override
        product_data["location_price_override"] = True
    if override.category_override:
        product_data["category"] = override.category_override
    if override.sort_order_override is not None:
        product_data["location_sort_order"] = override.sort_order_override
    return True


def effective_line_price(
    session: Session,
    location: models.TenantLocation | None,
    *,
    tenant_product_id: int | None = None,
    product_id: int | None = None,
    base_price_cents: int,
    on_date: date | None = None,
) -> int:
    if location is None or location.menu_mode != "override":
        return base_price_cents
    by_tp, by_product = menu_override_maps(session, location)
    override = by_tp.get(int(tenant_product_id)) if tenant_product_id is not None else None
    if override is None and product_id is not None:
        override = by_product.get(int(product_id))
    if override is None:
        return base_price_cents
    today = on_date or date.today()
    if override.enabled is False:
        raise HTTPException(status_code=409, detail="This item is not available at this location")
    if override.available_from and today < override.available_from:
        raise HTTPException(status_code=409, detail="This item is not available at this location")
    if override.available_until and today > override.available_until:
        raise HTTPException(status_code=409, detail="This item is not available at this location")
    return int(override.price_cents_override if override.price_cents_override is not None else base_price_cents)


def resolved_kitchen_station_id(
    tenant: models.Tenant,
    location: models.TenantLocation | None,
) -> int | None:
    if location and location.kitchen_mode == "override" and location.default_kitchen_station_id:
        return location.default_kitchen_station_id
    return tenant.default_kitchen_station_id


def payment_account_snapshot(
    tenant: models.Tenant,
    location: models.TenantLocation | None,
) -> str:
    if location and location.payment_mode == "override" and location.payment_account_reference:
        return location.payment_account_reference
    if tenant.stripe_payment_mode == "connect" and tenant.stripe_connected_account_id:
        return tenant.stripe_connected_account_id
    return "tenant-default"


def snapshot_order_context(
    order: models.Order,
    point: models.Table,
    tenant: models.Tenant,
    location: models.TenantLocation | None,
) -> None:
    order.location_id = location.id if location else None
    order.location_name_snapshot = location.display_name if location else tenant.name
    order.service_point_type_snapshot = point.service_point_type or "table"
    order.service_point_label_snapshot = service_point_label(point)
    order.kitchen_station_id_snapshot = resolved_kitchen_station_id(tenant, location)
    order.payment_account_snapshot = payment_account_snapshot(tenant, location)
    order.ordering_point_assignment_version_snapshot = int(point.assignment_version or 1)
