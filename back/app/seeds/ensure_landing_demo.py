"""Create or repair the fictional tenant used by the Scanaki landing-page demo.

This seed is idempotent and deliberately stores no real restaurant contact data.
It also clears the demo flag from every other tenant so customer businesses can
never appear in the public landing-page tenant list by accident.

Usage:
  docker compose exec back python -m app.seeds.ensure_landing_demo
"""

from __future__ import annotations

from pathlib import Path
from shutil import copy2

from sqlmodel import Session, select

from app.db import engine
from app.models import BusinessType, Floor, Product, Table, Tenant


DEMO_TENANT_NAME = "Scanaki Demo Restaurant"
DEMO_DESCRIPTION = "Fictional demonstration venue. No real restaurant or customer data."
DEMO_PRODUCTS = (
    ("Fish & Chips", 1395, "Mains", "Crispy fish, chips, peas and tartare sauce", "fish-and-chips.jpg"),
    ("Classic Beef Burger", 1295, "Mains", "Beef burger with salad and skin-on chips", "classic-beef-burger.jpg"),
    ("Plant Burger", 1250, "Mains", "Plant-based burger with salad and skin-on chips", "plant-burger.jpg"),
    ("Chicken Wings", 795, "Small Plates", "Chicken wings with house sauce", "chicken-wings.jpg"),
    ("Halloumi Fries", 695, "Small Plates", "Halloumi fries with chilli jam", "halloumi-fries.jpg"),
    ("Skin-on Chips", 395, "Sides", "Crisp skin-on potato chips", "skin-on-chips.jpg"),
    ("Sticky Toffee Pudding", 650, "Desserts", "Warm pudding with toffee sauce", "sticky-toffee-pudding.jpg"),
    ("House Lemonade", 325, "Soft Drinks", "Fresh sparkling lemonade", "house-lemonade.jpg"),
    ("Cola", 300, "Soft Drinks", "Chilled cola", "cola.jpg"),
    ("Traditional Sausage Roll", 495, "Small Plates", "Puff pastry sausage roll", "traditional-sausage-roll.jpg"),
)
DEMO_TABLES = (
    ("Take Away", 2, True),
    ("Demo Table 1", 4, False),
    ("Demo Table 2", 4, False),
    ("Demo Table 3", 2, False),
)

_ASSET_DIR = Path(__file__).resolve().parent / "assets" / "demo-menu"
_UPLOADS_DIR = Path(__file__).resolve().parents[2] / "uploads"


def run() -> None:
    with Session(engine) as session:
        demo = session.exec(
            select(Tenant).where(Tenant.name == DEMO_TENANT_NAME)
        ).first()
        if not demo:
            demo = Tenant(name=DEMO_TENANT_NAME)

        for tenant in session.exec(select(Tenant).where(Tenant.is_demo == True)).all():
            if tenant.id != demo.id:
                tenant.is_demo = False
                session.add(tenant)

        demo.is_demo = True
        demo.business_type = BusinessType.restaurant
        demo.description = DEMO_DESCRIPTION
        demo.phone = None
        demo.email = None
        demo.whatsapp = None
        demo.address = None
        demo.website = None
        demo.logo_filename = None
        demo.header_background_filename = None
        demo.opening_hours = "Demo venue - menu preview only"
        demo.country_code = "GB"
        demo.currency_code = "GBP"
        demo.currency = "£"
        demo.default_language = "en"
        demo.timezone = "Europe/London"
        demo.ordering_mode = "menu_only"
        demo.ordering_paused = False
        demo.immediate_payment_required = False
        demo.delivery_enabled = False
        demo.onboarding_status = "completed"
        session.add(demo)
        session.commit()
        session.refresh(demo)
        assert demo.id is not None

        floor = session.exec(
            select(Floor).where(Floor.tenant_id == demo.id, Floor.name == "Demo Floor")
        ).first()
        if not floor:
            floor = Floor(
                tenant_id=demo.id,
                name="Demo Floor",
                sort_order=0,
                is_active=True,
                seating_zone="indoor",
            )
            session.add(floor)
            session.commit()
            session.refresh(floor)

        existing_tables = {
            table.name: table
            for table in session.exec(select(Table).where(Table.tenant_id == demo.id)).all()
        }
        for index, (name, seats, active) in enumerate(DEMO_TABLES):
            table = existing_tables.get(name)
            if not table:
                table = Table(tenant_id=demo.id, name=name)
            table.floor_id = floor.id
            table.seat_count = seats
            table.is_active = active
            table.x_position = 40 + (index % 2) * 140
            table.y_position = 40 + (index // 2) * 100
            session.add(table)

        existing_products = {
            product.name: product
            for product in session.exec(select(Product).where(Product.tenant_id == demo.id)).all()
        }
        product_upload_dir = _UPLOADS_DIR / str(demo.id) / "products"
        product_upload_dir.mkdir(parents=True, exist_ok=True)
        for name, price_cents, category, description, image_filename in DEMO_PRODUCTS:
            source_image = _ASSET_DIR / image_filename
            if not source_image.is_file():
                raise RuntimeError(f"Missing packaged demo image: {source_image}")
            copy2(source_image, product_upload_dir / image_filename)
            product = existing_products.get(name)
            if not product:
                product = Product(tenant_id=demo.id, name=name, price_cents=price_cents)
            product.price_cents = price_cents
            product.category = category
            product.subcategory = None
            product.description = description
            product.ingredients = None
            product.image_filename = image_filename
            session.add(product)

        session.commit()
        print(
            f"LANDING_DEMO_READY tenant_id={demo.id} "
            f"tables={len(DEMO_TABLES)} products={len(DEMO_PRODUCTS)}"
        )


if __name__ == "__main__":
    run()
