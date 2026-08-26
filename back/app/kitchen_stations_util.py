"""Resolve KDS prep station and route for order lines (kitchen vs bar display)."""

from __future__ import annotations

from . import models


def resolve_order_item_kds(
    product: models.Product | None,
    tenant: models.Tenant,
    station_by_id: dict[int, models.KitchenStation],
    location_default_station_id: int | None = None,
) -> tuple[int | None, str | None, str]:
    """
    Returns (kitchen_station_id, kitchen_station_name, kitchen_station_route).
    kitchen_station_route is always 'kitchen' or 'bar' for KDS filtering.
    """
    if getattr(tenant, "kds_routing_mode", "split") == "kitchen_all":
        candidate_ids = (
            product.kitchen_station_id if product else None,
            location_default_station_id,
            tenant.default_kitchen_station_id,
        )
        for station_id in candidate_ids:
            if not station_id:
                continue
            station = station_by_id.get(station_id)
            if station and (station.display_route or "kitchen") == "kitchen":
                return station.id, station.name, "kitchen"
        return None, None, "kitchen"
    if product and product.kitchen_station_id:
        st = station_by_id.get(product.kitchen_station_id)
        if st:
            return st.id, st.name, st.display_route or "kitchen"
    if location_default_station_id and location_default_station_id in station_by_id:
        st = station_by_id[location_default_station_id]
        return st.id, st.name, st.display_route or "kitchen"
    is_beverages = bool(product and (product.category or "") == "Beverages")
    if is_beverages:
        did = tenant.default_bar_station_id
        if did and did in station_by_id:
            st = station_by_id[did]
            return st.id, st.name, st.display_route or "bar"
        return None, None, "bar"
    kid = tenant.default_kitchen_station_id
    if kid and kid in station_by_id:
        st = station_by_id[kid]
        return st.id, st.name, st.display_route or "kitchen"
    return None, None, "kitchen"


def validate_kitchen_station_belongs(
    session,
    station_id: int,
    tenant_id: int,
) -> models.KitchenStation:
    st = session.get(models.KitchenStation, station_id)
    if not st or st.tenant_id != tenant_id:
        raise ValueError("Invalid kitchen station")
    return st


def normalize_display_route(value: str) -> str:
    v = (value or "kitchen").strip().lower()
    if v not in ("kitchen", "bar"):
        raise ValueError("display_route must be 'kitchen' or 'bar'")
    return v
