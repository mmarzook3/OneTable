"""Tenant-configurable Kitchen press-and-hold and status cooldown timings."""
from __future__ import annotations

from datetime import timedelta
import uuid

from pg_client_mixin import PgClientTestCase

from app import models, security


def _headers(user: models.User) -> dict[str, str]:
    token = security.create_access_token(
        {
            "sub": user.email,
            "tenant_id": user.tenant_id,
            "provider_id": None,
            "token_version": user.token_version,
        },
        expires_delta=timedelta(minutes=30),
    )
    return {"Authorization": f"Bearer {token}"}


class TestKitchenActionDelays(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        suffix = uuid.uuid4().hex[:8]
        tenant = models.Tenant(name=f"Kitchen timing {suffix}")
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)
        self.user = models.User(
            email=f"kitchen-timing-{suffix}@test.local",
            hashed_password=security.get_password_hash("secret"),
            tenant_id=tenant.id,
            role=models.UserRole.kitchen,
        )
        self.session.add(self.user)
        self.session.commit()
        self.session.refresh(self.user)

    def test_defaults_and_update_round_trip(self) -> None:
        initial = self.client.get(
            "/tenant/kitchen-display-settings",
            headers=_headers(self.user),
        )
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertEqual(initial.json()["action_hold_seconds"], 1)
        self.assertEqual(initial.json()["action_cooldown_seconds"], 2)

        body = initial.json()
        body["action_hold_seconds"] = 3
        body["action_cooldown_seconds"] = 7
        updated = self.client.put(
            "/tenant/kitchen-display-settings",
            headers=_headers(self.user),
            json=body,
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["action_hold_seconds"], 3)
        self.assertEqual(updated.json()["action_cooldown_seconds"], 7)

    def test_rejects_out_of_range_delays(self) -> None:
        too_short = self.client.put(
            "/tenant/kitchen-display-settings",
            headers=_headers(self.user),
            json={"action_hold_seconds": 0},
        )
        self.assertEqual(too_short.status_code, 400, too_short.text)

        too_long = self.client.put(
            "/tenant/kitchen-display-settings",
            headers=_headers(self.user),
            json={"action_cooldown_seconds": 31},
        )
        self.assertEqual(too_long.status_code, 400, too_long.text)

