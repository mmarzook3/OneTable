"""Compact, bounded-query Kitchen display feed."""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from sqlalchemy import or_
from sqlmodel import Session, select

from . import models
from .db import get_session
from .kds_feed_cache import (
    begin_kds_feed_build,
    finish_kds_feed_build,
    get_kds_feed,
    wait_for_kds_feed,
)
from .kitchen_stations_util import resolve_order_item_kds
from .permissions import Permission, require_permission


router = APIRouter()

_ACTIVE_ORDER_STATUSES = (
    models.OrderStatus.pending,
    models.OrderStatus.preparing,
    models.OrderStatus.ready,
    models.OrderStatus.partially_delivered,
    models.OrderStatus.paid,
)
_ACTIVE_ITEM_STATUSES = (
    models.OrderItemStatus.pending,
    models.OrderItemStatus.preparing,
    models.OrderItemStatus.ready,
)


def _channel_value(order: models.Order) -> str:
    value = getattr(order, "order_channel", None)
    if value is None:
        return (
            models.OrderChannel.marketplace.value
            if order.delivery_integration_id
            else models.OrderChannel.table.value
        )
    return value.value if hasattr(value, "value") else str(value)


@router.get("/orders/kitchen-feed")
async def kitchen_order_feed(
    current_user: Annotated[
        models.User,
        Depends(require_permission(Permission.ORDER_READ)),
    ],
    limit: int = Query(default=500, ge=1, le=1000),
    session: Session = Depends(get_session),
) -> Response:
    """Return only fields required by Kitchen/Bar, using a bounded query count."""
    tenant_id = int(current_user.tenant_id)
    # Authentication and this route share FastAPI's request-scoped Session.
    # End the read-only authentication transaction before cache waiting so a
    # large reconnect burst cannot pin the SQL pool while doing no DB work.
    session.commit()
    cached = get_kds_feed(tenant_id, limit)
    if cached is not None:
        return Response(
            content=cached,
            media_type="application/json",
            headers={"X-KDS-Feed-Cache": "hit"},
        )

    ownership = begin_kds_feed_build(tenant_id, limit)
    if ownership is None:
        cached = await wait_for_kds_feed(tenant_id, limit)
        if cached is not None:
            return Response(
                content=cached,
                media_type="application/json",
                headers={"X-KDS-Feed-Cache": "coalesced"},
            )

    result = await run_in_threadpool(_build_kitchen_order_feed, tenant_id, limit, session)
    payload = json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    finish_kds_feed_build(tenant_id, limit, payload, ownership)
    return Response(
        content=payload,
        media_type="application/json",
        headers={"X-KDS-Feed-Cache": "miss"},
    )
def _build_kitchen_order_feed(
    tenant_id: int,
    limit: int,
    session: Session,
) -> list[dict]:
    tenant = session.get(models.Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    orders = session.exec(
        select(models.Order)
        .where(
            models.Order.tenant_id == tenant_id,
            models.Order.deleted_at.is_(None),
            models.Order.status.in_(_ACTIVE_ORDER_STATUSES),
            or_(
                models.Order.requires_prepayment == False,  # noqa: E712
                models.Order.kitchen_released_at.is_not(None),
            ),
        )
        .order_by(models.Order.created_at.asc())
        .limit(limit)
    ).all()
    if not orders:
        return []

    order_ids = [row.id for row in orders if row.id is not None]
    items = session.exec(
        select(models.OrderItem)
        .where(
            models.OrderItem.order_id.in_(order_ids),
            models.OrderItem.removed_by_customer == False,  # noqa: E712
            models.OrderItem.removed_by_user_id.is_(None),
            models.OrderItem.status.in_(_ACTIVE_ITEM_STATUSES),
        )
        .order_by(models.OrderItem.order_id, models.OrderItem.id)
    ).all()
    items_by_order: dict[int, list[models.OrderItem]] = {}
    for item in items:
        items_by_order.setdefault(item.order_id, []).append(item)

    table_ids = {row.table_id for row in orders if row.table_id is not None}
    tables = (
        session.exec(select(models.Table).where(models.Table.id.in_(table_ids))).all()
        if table_ids
        else []
    )
    table_by_id = {row.id: row for row in tables if row.id is not None}

    location_ids = {
        location_id
        for location_id in [
            *(row.location_id for row in orders),
            *(row.location_id for row in tables),
        ]
        if location_id is not None
    }
    locations = (
        session.exec(
            select(models.TenantLocation).where(models.TenantLocation.id.in_(location_ids))
        ).all()
        if location_ids
        else []
    )
    location_by_id = {row.id: row for row in locations if row.id is not None}

    product_ids = {item.product_id for item in items}
    products = (
        session.exec(select(models.Product).where(models.Product.id.in_(product_ids))).all()
        if product_ids
        else []
    )
    product_by_id = {row.id: row for row in products if row.id is not None}

    stations = session.exec(
        select(models.KitchenStation).where(
            models.KitchenStation.tenant_id == tenant_id
        )
    ).all()
    station_by_id = {row.id: row for row in stations if row.id is not None}

    result: list[dict] = []
    for order in orders:
        order_items = items_by_order.get(order.id or 0, [])
        if not order_items:
            continue
        table = table_by_id.get(order.table_id)
        location_id = order.location_id or (table.location_id if table else None)
        location = location_by_id.get(location_id)
        location_station = (
            order.kitchen_station_id_snapshot
            if location is not None and location.kitchen_mode == "override"
            else None
        )
        serialized_items: list[dict] = []
        for item in order_items:
            product = product_by_id.get(item.product_id)
            station_id, station_name, station_route = resolve_order_item_kds(
                product,
                tenant,
                station_by_id,
                location_default_station_id=location_station,
            )
            serialized_items.append(
                {
                    "id": item.id,
                    "product_name": item.product_name,
                    "quantity": item.quantity,
                    "price_cents": item.price_cents,
                    "notes": item.notes,
                    "customization_answers": item.customization_answers or None,
                    "customization_summary": item.customization_summary or None,
                    "line_modifiers": item.line_modifiers or None,
                    "line_modifiers_summary": item.line_modifiers_summary or None,
                    "status": item.status.value,
                    "removed_by_customer": False,
                    "category": product.category if product else None,
                    "kitchen_station_id": station_id,
                    "kitchen_station_name": station_name,
                    "kitchen_station_route": station_route,
                }
            )

        channel = _channel_value(order)
        if channel == models.OrderChannel.satisfecho_delivery.value:
            table_name = "Scanaki Delivery"
        elif order.delivery_integration_id or channel == models.OrderChannel.marketplace.value:
            table_name = "Delivery"
        else:
            table_name = table.name if table else "Unknown"
        subtotal = sum(item.price_cents * item.quantity for item in order_items)
        result.append(
            {
                "id": order.id,
                "table_name": table_name,
                "table_id": table.id if table else None,
                "table_token": table.token if table else None,
                "status": order.status.value,
                "notes": order.notes,
                "customer_name": order.customer_name,
                "created_at": order.created_at.isoformat(),
                "items": serialized_items,
                "subtotal_cents": subtotal,
                "total_cents": subtotal + int(order.tip_amount_cents or 0),
                "paid_at": order.paid_at.isoformat() if order.paid_at else None,
                "payment_method": order.payment_method,
                "payment_state": order.payment_state,
                "staff_urgent": bool(order.staff_urgent),
                "order_channel": channel,
                "delivery_address": order.delivery_address,
                "customer_phone": order.customer_phone,
                "delivery_integration_id": order.delivery_integration_id,
                "external_order_ref": order.external_order_ref,
                "requires_prepayment": bool(order.requires_prepayment),
                "kitchen_released_at": (
                    order.kitchen_released_at.isoformat()
                    if order.kitchen_released_at
                    else None
                ),
                "location_id": location_id,
                "location_name": (
                    order.location_name_snapshot
                    or (location.display_name if location else None)
                ),
                "service_point_type": (
                    order.service_point_type_snapshot
                    or (table.service_point_type if table else None)
                ),
                "service_point_label": (
                    order.service_point_label_snapshot
                    or (table.customer_label or table.display_number or table.name if table else None)
                ),
                "kitchen_station_id_snapshot": order.kitchen_station_id_snapshot,
                "payment_account_snapshot": order.payment_account_snapshot,
            }
        )
    return result
