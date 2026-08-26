"""
Ensure tenant 1 has one courier-role user for Scanaki Delivery / courier demos.

Idempotent: if any courier already exists on tenant 1, does nothing. Otherwise
creates (or promotes) the demo courier using COURIER_EMAIL / COURIER_PASSWORD
(defaults match front/scripts/test-courier-actions.mjs). Does not create couriers
on other tenants. Does not delete users.

Usage:
  docker compose exec back python -m app.seeds.seed_demo_courier_user
  cd back && python -m app.seeds.seed_demo_courier_user

Env (optional):
  COURIER_EMAIL       Default courier-test-phase1@amvara.de
  COURIER_PASSWORD    Default secret
"""

import os
import sys

from sqlmodel import Session, select

from app import security
from app.db import engine
from app.models import Tenant, User, UserRole

DEMO_TENANT_ID = 1
DEFAULT_COURIER_EMAIL = "courier-test-phase1@amvara.de"
DEFAULT_COURIER_PASSWORD = "secret"
DEFAULT_FULL_NAME = "Demo Courier"


def _demo_credentials() -> tuple[str, str]:
    email = os.environ.get("COURIER_EMAIL", DEFAULT_COURIER_EMAIL).strip()
    password = os.environ.get("COURIER_PASSWORD", DEFAULT_COURIER_PASSWORD).strip()
    return email, password


def run() -> None:
    email, password = _demo_credentials()
    if not email or not password:
        print(
            "COURIER_EMAIL and COURIER_PASSWORD must be non-empty.",
            file=sys.stderr,
        )
        sys.exit(1)

    with Session(engine) as session:
        tenant = session.get(Tenant, DEMO_TENANT_ID)
        if not tenant:
            print("Tenant 1 not found. Run bootstrap_demo first.")
            return

        existing_courier = session.exec(
            select(User)
            .where(User.tenant_id == DEMO_TENANT_ID, User.role == UserRole.courier)
            .limit(1)
        ).first()
        if existing_courier is not None:
            print(
                f"Tenant {DEMO_TENANT_ID} already has courier "
                f"id={existing_courier.id} ({existing_courier.email}). Skipping."
            )
            return

        hashed = security.get_password_hash(password)
        user = session.exec(select(User).where(User.email == email)).first()
        if user is not None:
            if user.tenant_id != DEMO_TENANT_ID:
                print(
                    f"Email {email} already belongs to tenant_id={user.tenant_id}; "
                    f"cannot create demo courier for tenant {DEMO_TENANT_ID}. "
                    "Set COURIER_EMAIL to an unused address.",
                    file=sys.stderr,
                )
                sys.exit(1)
            user.role = UserRole.courier
            user.hashed_password = hashed
            user.provider_id = None
            if not user.full_name:
                user.full_name = DEFAULT_FULL_NAME
            session.add(user)
            session.commit()
            print(
                f"Tenant {DEMO_TENANT_ID}: promoted {email} to role courier "
                f"(id={user.id})."
            )
            return

        user = User(
            email=email,
            hashed_password=hashed,
            full_name=DEFAULT_FULL_NAME,
            role=UserRole.courier,
            tenant_id=DEMO_TENANT_ID,
            provider_id=None,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        print(
            f"Tenant {DEMO_TENANT_ID}: created courier {email} (id={user.id})."
        )


if __name__ == "__main__":
    run()
