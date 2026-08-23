"""
Check that tenant 1 has demo Scanaki Delivery fee and/or zone configured.

Exits 0 when fee > 0 or postal codes / radius are set; exits 1 otherwise.
Use after seed_demo_delivery_settings or reset_demo_data.

Usage:
  cd back && python -m app.seeds.check_demo_delivery_settings
  docker compose exec back python -m app.seeds.check_demo_delivery_settings
"""

import sys

from sqlmodel import Session

from app.db import engine
from app.delivery_order_service import parse_delivery_postal_codes
from app.models import Tenant

DEMO_TENANT_ID = 1


def run() -> int:
    with Session(engine) as session:
        tenant = session.get(Tenant, DEMO_TENANT_ID)
        if not tenant:
            print(f"Tenant {DEMO_TENANT_ID} not found.")
            return 1

        fee = int(getattr(tenant, "delivery_fee_cents", 0) or 0)
        postal = parse_delivery_postal_codes(getattr(tenant, "delivery_postal_codes", None))
        radius = getattr(tenant, "delivery_radius_meters", None)
        radius_active = radius is not None and int(radius) > 0

        if fee <= 0 and not postal and not radius_active:
            print(
                f"Tenant {DEMO_TENANT_ID} has no delivery fee/zone "
                f"(fee={fee}, postal={postal!r}, radius={radius}). "
                "Run: python -m app.seeds.seed_demo_delivery_settings"
            )
            return 1

        print(
            f"OK: tenant {DEMO_TENANT_ID} delivery settings "
            f"fee_cents={fee}, postal_codes={postal or []}, "
            f"radius_meters={radius}."
        )
        return 0


if __name__ == "__main__":
    sys.exit(run())
