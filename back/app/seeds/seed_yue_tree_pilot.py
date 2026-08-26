"""Provision the idempotent Scanaki pilot tenant for The Yew Trees Pub.

This seed is safe to rerun: it updates the pilot policy, creates only missing
tables/products/stations, and creates or resets the two pilot accounts only when
their credentials are supplied through environment variables.

Usage:
  docker compose exec back python -m app.seeds.seed_yue_tree_pilot
"""

from __future__ import annotations

import os
from uuid import uuid4

from sqlmodel import Session, select

from app.db import engine
from app.models import (
    BusinessType,
    Floor,
    KitchenStation,
    Product,
    Table,
    Tenant,
    TenantLocation,
    User,
    UserRole,
)
from app.security import get_password_hash


TENANT_NAME = "The Yew Trees Pub"
TABLE_COUNT = 10
SERVICE_HOURS = {
    "monday": {"open": "14:00", "close": "23:00"},
    "tuesday": {"open": "14:00", "close": "23:00"},
    "wednesday": {"open": "14:00", "close": "23:00"},
    "thursday": {"open": "14:00", "close": "23:00"},
    "friday": {"open": "14:00", "close": "00:00"},
    "saturday": {"open": "12:00", "close": "00:00"},
    "sunday": {"open": "12:00", "close": "22:30"},
}

PILOT_LOCATIONS = (
    ("The Yew Trees", "The Yew Trees", "the-yew-trees", "pub", 0),
    ("Sports Lounge", "Sports Lounge", "sports-lounge", "lounge", 10),
    ("Premium Building", "Blaby Hotel - Premium Building", "premium-building", "hotel_building", 20),
    ("Main Building", "Blaby Hotel - Main Building", "main-building", "hotel_building", 30),
)

# Acceptance-test data only. Replace it with the venue's approved menu before launch.
PILOT_PRODUCTS = (
    ("Fish & Chips", 1395, "Mains", "crispy battered fish, chips, peas, tartare sauce"),
    ("Classic Beef Burger", 1295, "Mains", "beef patty, cheese, lettuce, tomato, chips"),
    ("Plant Burger", 1250, "Mains", "plant-based patty, lettuce, tomato, chips"),
    ("Chicken Wings", 795, "Small Plates", "chicken wings, house sauce"),
    ("Halloumi Fries", 695, "Small Plates", "halloumi, chilli jam"),
    ("Skin-on Chips", 395, "Sides", "potatoes"),
    ("Sticky Toffee Pudding", 650, "Desserts", "dates, toffee sauce, ice cream"),
    ("House Lemonade", 325, "Soft Drinks", None),
    ("Cola", 300, "Soft Drinks", None),
    (
        "Traditional Sausage Roll",
        495,
        "Small Plates",
        "pork sausage, puff pastry, English mustard",
    ),
)

PILOT_DESCRIPTION = "Pilot menu item - confirm before live launch"


def _upsert_account(
    session: Session,
    tenant_id: int,
    *,
    email_env: str,
    password_env: str,
    role: UserRole,
    full_name: str,
) -> bool:
    email = os.environ.get(email_env, "").strip().lower()
    password = os.environ.get(password_env, "")
    if not email or not password:
        return False
    if len(password) < 12:
        raise ValueError(f"{password_env} must contain at least 12 characters")
    user = session.exec(select(User).where(User.email == email)).first()
    if user and user.tenant_id != tenant_id:
        raise ValueError(f"{email_env} is already used by a different tenant")
    if not user:
        user = User(
            email=email,
            hashed_password=get_password_hash(password),
            full_name=full_name,
            role=role,
            tenant_id=tenant_id,
        )
    else:
        user.hashed_password = get_password_hash(password)
        user.full_name = full_name
        user.role = role
    session.add(user)
    return True


def run() -> None:
    table_count_raw = os.environ.get("YUE_TREE_TABLE_COUNT", str(TABLE_COUNT))
    try:
        table_count = max(1, min(int(table_count_raw), 100))
    except ValueError as exc:
        raise ValueError("YUE_TREE_TABLE_COUNT must be a number from 1 to 100") from exc

    with Session(engine) as session:
        tenant = session.exec(select(Tenant).where(Tenant.name == TENANT_NAME)).first()
        if not tenant:
            tenant = Tenant(name=TENANT_NAME)
        tenant.business_type = BusinessType.bar
        tenant.description = "Scanaki pilot venue"
        tenant.country_code = "GB"
        tenant.currency_code = "GBP"
        tenant.currency = "£"
        tenant.default_language = "en"
        tenant.timezone = "Europe/London"
        tenant.ordering_mode = "automatic"
        tenant.immediate_payment_required = True
        tenant.ordering_paused = False
        tenant.ordering_pause_reason = None
        tenant.ordering_service_hours = SERVICE_HOURS
        tenant.require_kds_online = True
        tenant.kds_heartbeat_timeout_seconds = 30
        tenant.strict_fifo_kds = True
        tenant.kds_routing_mode = "kitchen_all"
        tenant.saas_plan_code = "pilot"
        tenant.saas_included_tables = 10_000
        tenant.saas_extra_tables = 0
        tenant.saas_monthly_price_cents = 0
        tenant.saas_extra_table_unit_price_cents = 0
        tenant.saas_subscription_status = "grandfathered"
        tenant.ui_modules = None
        session.add(tenant)
        session.commit()
        session.refresh(tenant)
        assert tenant.id is not None

        locations_by_slug = {
            row.slug: row
            for row in session.exec(
                select(TenantLocation).where(TenantLocation.tenant_id == tenant.id)
            ).all()
        }
        if "the-yew-trees" not in locations_by_slug and "the-yew-trees-pub" in locations_by_slug:
            default_location = locations_by_slug.pop("the-yew-trees-pub")
            default_location.slug = "the-yew-trees"
            locations_by_slug["the-yew-trees"] = default_location
        for name, display_name, slug, location_type, sort_order in PILOT_LOCATIONS:
            location = locations_by_slug.get(slug)
            if location is None:
                location = TenantLocation(
                    tenant_id=tenant.id,
                    name=name,
                    display_name=display_name,
                    slug=slug,
                    location_type=location_type,
                )
                location.menu_mode = "inherit"
                location.hours_mode = "inherit"
                location.kitchen_mode = "inherit"
                location.payment_mode = "inherit"
            location.name = name
            location.display_name = display_name
            location.location_type = location_type
            location.sort_order = sort_order
            session.add(location)
            locations_by_slug[slug] = location
        session.commit()
        yew_location = locations_by_slug["the-yew-trees"]
        session.refresh(yew_location)

        floor = session.exec(
            select(Floor).where(Floor.tenant_id == tenant.id, Floor.name == "Main")
        ).first()
        if not floor:
            floor = Floor(tenant_id=tenant.id, name="Main", sort_order=0)
            session.add(floor)
            session.commit()
            session.refresh(floor)

        station = session.exec(
            select(KitchenStation).where(
                KitchenStation.tenant_id == tenant.id,
                KitchenStation.name == "Kitchen",
            )
        ).first()
        if not station:
            station = KitchenStation(
                tenant_id=tenant.id,
                name="Kitchen",
                sort_order=0,
                display_route="kitchen",
            )
            session.add(station)
            session.commit()
            session.refresh(station)
        tenant.default_kitchen_station_id = station.id
        session.add(tenant)

        existing_tables = {
            table.name: table
            for table in session.exec(select(Table).where(Table.tenant_id == tenant.id)).all()
        }
        # Existing pilot layouts are venue-owned configuration. Never recreate the
        # original Table 1..N template after rooms/benches have been renamed or moved.
        if not existing_tables:
            for number in range(1, table_count + 1):
                name = f"Table {number}"
                column = (number - 1) % 4
                row = (number - 1) // 4
                session.add(
                    Table(
                        tenant_id=tenant.id,
                        name=name,
                        token=str(uuid4()),
                        floor_id=floor.id,
                        location_id=yew_location.id,
                        service_point_type="table",
                        display_number=str(number),
                        is_ordering_enabled=True,
                        seat_count=4,
                        x_position=40 + column * 140,
                        y_position=40 + row * 100,
                        is_active=False,
                        plaque_status="not_created",
                    )
                )

        existing_products = {
            product.name: product
            for product in session.exec(
                select(Product).where(Product.tenant_id == tenant.id)
            ).all()
        }
        for existing_product in existing_products.values():
            if existing_product.description == "Pilot menu item — confirm before live launch":
                existing_product.description = PILOT_DESCRIPTION
                session.add(existing_product)

        # Migrate the original pilot menu without introducing any restriction logic:
        # Scanaki simply does not promote alcohol-related demo content.
        fish_and_chips = existing_products.get("Fish & Chips")
        if (
            fish_and_chips
            and fish_and_chips.ingredients
            == "beer-battered fish, chips, peas, tartare sauce"
        ):
            fish_and_chips.ingredients = "crispy battered fish, chips, peas, tartare sauce"
            session.add(fish_and_chips)

        legacy_lager = existing_products.pop("Alcohol-free Lager", None)
        if legacy_lager:
            if "Traditional Sausage Roll" not in existing_products:
                legacy_lager.name = "Traditional Sausage Roll"
                legacy_lager.price_cents = 495
                legacy_lager.category = "Small Plates"
                legacy_lager.subcategory = None
                legacy_lager.ingredients = "pork sausage, puff pastry, English mustard"
                legacy_lager.description = PILOT_DESCRIPTION
                legacy_lager.kitchen_station_id = station.id
                existing_products[legacy_lager.name] = legacy_lager
            else:
                legacy_lager.name = "Traditional Pork Pie"
                legacy_lager.price_cents = 495
                legacy_lager.category = "Small Plates"
                legacy_lager.subcategory = None
                legacy_lager.ingredients = "seasoned pork, hot-water crust pastry"
                legacy_lager.description = PILOT_DESCRIPTION
                legacy_lager.kitchen_station_id = station.id
                existing_products[legacy_lager.name] = legacy_lager
            session.add(legacy_lager)

        for name, price_cents, category, ingredients in PILOT_PRODUCTS:
            if name not in existing_products:
                session.add(
                    Product(
                        tenant_id=tenant.id,
                        name=name,
                        price_cents=price_cents,
                        category=category,
                        ingredients=ingredients,
                        description=PILOT_DESCRIPTION,
                        kitchen_station_id=station.id,
                    )
                )

        owner_ready = _upsert_account(
            session,
            tenant.id,
            email_env="YUE_TREE_OWNER_EMAIL",
            password_env="YUE_TREE_OWNER_PASSWORD",
            role=UserRole.owner,
            full_name="Yue Tree Owner",
        )
        kitchen_ready = _upsert_account(
            session,
            tenant.id,
            email_env="YUE_TREE_KITCHEN_EMAIL",
            password_env="YUE_TREE_KITCHEN_PASSWORD",
            role=UserRole.kitchen,
            full_name="Yue Tree Kitchen",
        )
        session.commit()

        print(
            f"Ready: tenant_id={tenant.id}, tables={table_count}, "
            f"pilot_products={len(PILOT_PRODUCTS)}, owner_account={owner_ready}, "
            f"kitchen_account={kitchen_ready}"
        )
        if not owner_ready or not kitchen_ready:
            print("Set the YUE_TREE_* account variables and rerun to create pilot logins.")


if __name__ == "__main__":
    run()
