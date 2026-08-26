"""
Bootstrap a demo tenant on virgin deployment so the first registration gets tables, products, and demo orders.

If no tenants exist, creates tenant 1 "Demo Restaurant", then runs seed_demo_tables,
seed_demo_products, seed_demo_delivery_settings, seed_demo_courier_user,
seed_demo_orders, seed_demo_reservations, and seed_demo_waiting_list for it. Deploy
runs this after migrations so that:
- First user to register is assigned to this tenant (see register() in main.py) and gets T01–T10 + demo products.
- Reports (Informes) show meaningful paid-order data (orders spread over the last ±90 days, biased to last 30).
- Reservations page shows a full list (demo reservations for today and tomorrow, plus spread for Reports).
- Waiting list tab / public /waitlist/1 show a small sample queue.
- Public /delivery/1 has a demo fee and postal coverage when unset.
- Demo courier user exists so Delivery samples can assign courier / out_for_delivery.
- No manual "run seeds after first register" step.

Usage:
  docker compose exec back python -m app.seeds.bootstrap_demo
"""

from sqlmodel import Session, select

from app.db import engine
from app.models import Tenant

DEMO_TENANT_NAME = "Scanaki Demo Restaurant"


def run() -> None:
    with Session(engine) as session:
        existing = session.exec(select(Tenant)).all()
        if existing:
            print("Tenants already exist. Skipping bootstrap.")
            return
        tenant = Tenant(name=DEMO_TENANT_NAME, is_demo=True)
        session.add(tenant)
        session.commit()
        session.refresh(tenant)
        print(f"Created tenant id={tenant.id} ({DEMO_TENANT_NAME}).")

    from app.seeds.seed_demo_courier_user import run as run_courier_user
    from app.seeds.seed_demo_delivery_settings import run as run_delivery_settings
    from app.seeds.seed_demo_tables import run as run_tables
    from app.seeds.seed_demo_products import run as run_products
    from app.seeds.seed_demo_orders import run as run_orders
    from app.seeds.seed_demo_reservations import run as run_reservations
    from app.seeds.seed_demo_waiting_list import run as run_waiting_list

    run_tables()
    run_products()
    run_delivery_settings()
    run_courier_user()
    run_orders()
    run_reservations()
    run_waiting_list()
    print("Bootstrap done.")


if __name__ == "__main__":
    run()
