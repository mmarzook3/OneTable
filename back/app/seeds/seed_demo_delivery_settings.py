"""
Ensure tenant 1 has demo Scanaki Delivery fee + postal coverage so public
`/delivery/1` and Settings → Payments show a non-zero fee and reject out-of-zone
codes after bootstrap or daily demo reset.

Idempotent: only fills when fee is 0 and no postal list / radius is configured.
Does not change other tenants. Does not overwrite operator-customized zone/fee.

Usage:
  docker compose exec back python -m app.seeds.seed_demo_delivery_settings
  cd back && python -m app.seeds.seed_demo_delivery_settings
"""

from sqlmodel import Session

from app.db import engine
from app.delivery_order_service import (
    parse_delivery_postal_codes,
    serialize_delivery_postal_codes,
)
from app.models import Tenant

DEMO_TENANT_ID = 1
DEMO_DELIVERY_FEE_CENTS = 250
# Madrid-style codes used in public delivery tests / demos
DEMO_DELIVERY_POSTAL_CODES = ["28001", "28013"]


def _needs_demo_settings(tenant: Tenant) -> bool:
    fee = int(getattr(tenant, "delivery_fee_cents", 0) or 0)
    postal = parse_delivery_postal_codes(getattr(tenant, "delivery_postal_codes", None))
    radius = getattr(tenant, "delivery_radius_meters", None)
    radius_active = radius is not None and int(radius) > 0
    return fee <= 0 and not postal and not radius_active


def run() -> None:
    with Session(engine) as session:
        tenant = session.get(Tenant, DEMO_TENANT_ID)
        if not tenant:
            print("Tenant 1 not found. Run bootstrap_demo first.")
            return

        if not _needs_demo_settings(tenant):
            print(
                f"Tenant {DEMO_TENANT_ID} already has delivery fee/zone configured "
                f"(fee={tenant.delivery_fee_cents}, "
                f"postal={tenant.delivery_postal_codes!r}, "
                f"radius={tenant.delivery_radius_meters}). Skipping."
            )
            return

        tenant.delivery_fee_cents = DEMO_DELIVERY_FEE_CENTS
        tenant.delivery_postal_codes = serialize_delivery_postal_codes(
            DEMO_DELIVERY_POSTAL_CODES
        )
        session.add(tenant)
        session.commit()
        print(
            f"Tenant {DEMO_TENANT_ID}: set delivery_fee_cents={DEMO_DELIVERY_FEE_CENTS}, "
            f"delivery_postal_codes={tenant.delivery_postal_codes}."
        )


if __name__ == "__main__":
    run()
