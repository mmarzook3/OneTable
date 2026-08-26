"""Reusable Scanaki smart-plaque inventory and assignment security."""

from datetime import timedelta

from pg_client_mixin import PgClientTestCase
from sqlmodel import select

from app import models, security


def _headers(user: models.User, *, platform: bool = False) -> dict[str, str]:
    token = security.create_access_token(
        {
            "sub": user.email,
            "tenant_id": None if platform else user.tenant_id,
            "provider_id": None,
            "is_platform_operator": platform,
            "token_version": user.token_version,
        },
        expires_delta=timedelta(minutes=30),
    )
    return {"Authorization": f"Bearer {token}"}


class TestSmartPlaques(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        from app.settings import settings

        self._previous_base = settings.public_app_base_url
        settings.public_app_base_url = "https://scanaki.uk"
        self.operator = models.User(
            email="smart-plaque-operator@amvara.de",
            hashed_password=security.get_password_hash("operator-password"),
            role=models.UserRole.platform_operator,
        )
        self.tenant_a = models.Tenant(name="Plaque Restaurant A")
        self.tenant_b = models.Tenant(name="Plaque Restaurant B")
        self.session.add_all([self.operator, self.tenant_a, self.tenant_b])
        self.session.flush()
        self.owner_a = models.User(
            email="smart-plaque-owner-a@amvara.de",
            hashed_password=security.get_password_hash("owner-password"),
            role=models.UserRole.owner,
            tenant_id=self.tenant_a.id,
        )
        self.owner_b = models.User(
            email="smart-plaque-owner-b@amvara.de",
            hashed_password=security.get_password_hash("owner-password"),
            role=models.UserRole.owner,
            tenant_id=self.tenant_b.id,
        )
        self.floor_a = models.Floor(tenant_id=self.tenant_a.id, name="Main")
        self.floor_b = models.Floor(tenant_id=self.tenant_b.id, name="Main")
        self.session.add_all([self.owner_a, self.owner_b, self.floor_a, self.floor_b])
        self.session.flush()
        self.table_a1 = models.Table(
            tenant_id=self.tenant_a.id,
            floor_id=self.floor_a.id,
            name="Table 1",
        )
        self.table_a2 = models.Table(
            tenant_id=self.tenant_a.id,
            floor_id=self.floor_a.id,
            name="Table 2",
        )
        self.table_b1 = models.Table(
            tenant_id=self.tenant_b.id,
            floor_id=self.floor_b.id,
            name="Table 1",
        )
        self.session.add_all([self.table_a1, self.table_a2, self.table_b1])
        self.session.commit()
        for row in (
            self.operator,
            self.tenant_a,
            self.tenant_b,
            self.owner_a,
            self.owner_b,
            self.table_a1,
            self.table_a2,
            self.table_b1,
        ):
            self.session.refresh(row)

    def tearDown(self) -> None:
        from app.settings import settings

        settings.public_app_base_url = self._previous_base
        super().tearDown()

    def _create_plaque(self) -> dict:
        response = self.client.post(
            "/platform/smart-plaques/batch",
            headers=_headers(self.operator, platform=True),
            json={"count": 1, "batch_label": "Yue Tree prototype"},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()[0]

    def _assign(self, plaque: dict, table: models.Table, **flags: bool):
        return self.client.post(
            "/smart-plaques/assign",
            headers=_headers(self.owner_a),
            json={
                "table_id": table.id,
                "plaque_code": plaque["public_url"],
                **flags,
            },
        )

    def _request_plaques(self, quantity: int = 2):
        return self.client.post(
            "/smart-plaque-requests",
            headers=_headers(self.owner_a),
            json={
                "quantity": quantity,
                "delivery_contact_name": "Plaque Owner",
                "delivery_address": "15 Enderby Road, Blaby, Leicester LE8 4GD",
                "restaurant_notes": "Pilot tables",
            },
        )

    def test_platform_creates_permanent_plaque_and_owner_assigns_it(self) -> None:
        plaque = self._create_plaque()
        self.assertTrue(plaque["public_url"].startswith("https://scanaki.uk/p/"))
        self.assertEqual(plaque["status"], "available")
        old_table_token = self.table_a1.token

        lookup = self.client.get(
            "/smart-plaques/lookup",
            headers=_headers(self.owner_a),
            params={"value": plaque["public_url"]},
        )
        self.assertEqual(lookup.status_code, 200, lookup.text)
        self.assertEqual(lookup.json()["assignment_state"], "available")

        assigned = self._assign(plaque, self.table_a1)
        self.assertEqual(assigned.status_code, 200, assigned.text)
        body = assigned.json()
        self.assertEqual(body["public_url"], plaque["public_url"])
        self.assertEqual(body["table_name"], "Table 1")
        self.assertEqual(body["status"], "assigned")
        self.assertNotEqual(body["table_token"], old_table_token)

        resolved = self.client.get(f"/public/smart-plaques/{plaque['public_code']}")
        self.assertEqual(resolved.status_code, 200, resolved.text)
        self.assertEqual(resolved.json()["table_name"], "Table 1")
        self.assertEqual(resolved.json()["menu_path"], f"/menu/{body['table_token']}")

    def test_same_restaurant_reassignment_requires_confirmation_and_rotates_tokens(self) -> None:
        plaque = self._create_plaque()
        first = self._assign(plaque, self.table_a1)
        self.assertEqual(first.status_code, 200, first.text)
        table_one_assigned_token = first.json()["table_token"]
        table_two_old_token = self.table_a2.token

        confirmation = self._assign(plaque, self.table_a2)
        self.assertEqual(confirmation.status_code, 409, confirmation.text)
        self.assertEqual(confirmation.json()["detail"]["code"], "confirm_plaque_reassignment")

        moved = self._assign(plaque, self.table_a2, confirm_reassignment=True)
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["public_url"], plaque["public_url"])
        self.assertEqual(moved.json()["table_name"], "Table 2")
        self.assertNotEqual(moved.json()["table_token"], table_two_old_token)
        self.session.refresh(self.table_a1)
        self.assertNotEqual(self.table_a1.token, table_one_assigned_token)

        events = self.session.exec(
            select(models.SmartPlaqueAssignmentEvent).where(
                models.SmartPlaqueAssignmentEvent.plaque_id == plaque["id"]
            )
        ).all()
        self.assertEqual([event.action for event in events], ["assigned", "reassigned"])

    def test_cross_tenant_takeover_is_blocked_until_platform_release(self) -> None:
        plaque = self._create_plaque()
        self.assertEqual(self._assign(plaque, self.table_a1).status_code, 200)

        blocked = self.client.post(
            "/smart-plaques/assign",
            headers=_headers(self.owner_b),
            json={"table_id": self.table_b1.id, "plaque_code": plaque["public_code"]},
        )
        self.assertEqual(blocked.status_code, 409, blocked.text)
        self.assertEqual(
            blocked.json()["detail"]["code"],
            "plaque_assigned_to_another_restaurant",
        )

        released = self.client.post(
            f"/platform/smart-plaques/{plaque['id']}/release",
            headers=_headers(self.operator, platform=True),
        )
        self.assertEqual(released.status_code, 200, released.text)
        assigned_b = self.client.post(
            "/smart-plaques/assign",
            headers=_headers(self.owner_b),
            json={"table_id": self.table_b1.id, "plaque_code": plaque["public_code"]},
        )
        self.assertEqual(assigned_b.status_code, 200, assigned_b.text)
        self.assertEqual(assigned_b.json()["assigned_tenant_id"], self.tenant_b.id)

    def test_nfc_verification_and_table_list_use_permanent_url(self) -> None:
        plaque = self._create_plaque()
        assigned = self._assign(plaque, self.table_a1).json()
        written = self.client.put(
            f"/smart-plaques/{plaque['id']}/nfc",
            headers=_headers(self.owner_a),
            json={"written": True},
        )
        self.assertEqual(written.status_code, 200, written.text)
        verified = self.client.put(
            f"/smart-plaques/{plaque['id']}/nfc",
            headers=_headers(self.owner_a),
            json={"verified": True},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertIsNotNone(verified.json()["nfc_verified_at"])

        tables = self.client.get("/tables", headers=_headers(self.owner_a))
        self.assertEqual(tables.status_code, 200, tables.text)
        table = next(row for row in tables.json() if row["id"] == self.table_a1.id)
        self.assertEqual(table["smart_plaque_url"], plaque["public_url"])
        self.assertEqual(table["menu_url"], plaque["public_url"])

        rotated = self.client.post(
            f"/tables/{self.table_a1.id}/rotate-token",
            headers=_headers(self.owner_a),
        )
        self.assertEqual(rotated.status_code, 200, rotated.text)
        self.assertEqual(rotated.json()["menu_url"], plaque["public_url"])
        self.assertNotEqual(rotated.json()["token"], assigned["table_token"])
        self.assertEqual(rotated.json()["plaque_status"], "installed")

    def test_active_table_cannot_move_and_delete_releases_inventory(self) -> None:
        plaque = self._create_plaque()
        self.assertEqual(self._assign(plaque, self.table_a1).status_code, 200)
        self.table_a1.is_active = True
        self.session.add(self.table_a1)
        self.session.commit()

        blocked = self._assign(plaque, self.table_a2, confirm_reassignment=True)
        self.assertEqual(blocked.status_code, 409, blocked.text)
        self.assertEqual(blocked.json()["detail"]["code"], "table_has_live_session")

        self.table_a1.is_active = False
        self.session.add(self.table_a1)
        self.session.commit()
        deleted = self.client.delete(
            f"/tables/{self.table_a1.id}", headers=_headers(self.owner_a)
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        row = self.session.get(models.SmartPlaque, plaque["id"])
        self.assertEqual(row.status, "available")
        self.assertIsNone(row.table_id)
        self.assertIsNone(row.assigned_tenant_id)

    def test_invalid_code_and_non_platform_batch_creation_are_rejected(self) -> None:
        invalid = self.client.get(
            "/smart-plaques/lookup",
            headers=_headers(self.owner_a),
            params={"value": "https://malicious.invalid/not-a-plaque"},
        )
        self.assertEqual(invalid.status_code, 400, invalid.text)
        denied = self.client.post(
            "/platform/smart-plaques/batch",
            headers=_headers(self.owner_a),
            json={"count": 1},
        )
        self.assertEqual(denied.status_code, 403, denied.text)

    def test_request_approval_shipping_delivery_and_installation_lifecycle(self) -> None:
        created = self._request_plaques()
        self.assertEqual(created.status_code, 201, created.text)
        request = created.json()
        self.assertEqual(request["status"], "requested")
        self.assertEqual(request["allocated_count"], 0)

        duplicate = self._request_plaques()
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(duplicate.json()["detail"]["code"], "active_plaque_request_exists")

        approved = self.client.post(
            f"/platform/smart-plaque-requests/{request['id']}/action",
            headers=_headers(self.operator, platform=True),
            json={"action": "approve", "platform_notes": "Approved pilot batch"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        approved_body = approved.json()
        self.assertEqual(approved_body["status"], "approved")
        self.assertEqual(approved_body["allocated_count"], 2)
        self.assertTrue(all(row["status"] == "reserved" for row in approved_body["plaques"]))

        too_early = self._assign(approved_body["plaques"][0], self.table_a1)
        self.assertEqual(too_early.status_code, 409, too_early.text)

        prepared = self.client.post(
            f"/platform/smart-plaque-requests/{request['id']}/action",
            headers=_headers(self.operator, platform=True),
            json={"action": "prepare"},
        )
        self.assertEqual(prepared.status_code, 200, prepared.text)
        shipped = self.client.post(
            f"/platform/smart-plaque-requests/{request['id']}/action",
            headers=_headers(self.operator, platform=True),
            json={"action": "ship", "tracking_reference": "TEST-TRACK-100"},
        )
        self.assertEqual(shipped.status_code, 200, shipped.text)
        self.assertEqual(shipped.json()["tracking_reference"], "TEST-TRACK-100")

        received = self.client.post(
            f"/smart-plaque-requests/{request['id']}/confirm-delivery",
            headers=_headers(self.owner_a),
        )
        self.assertEqual(received.status_code, 200, received.text)
        self.assertEqual(received.json()["status"], "delivered")
        first, second = received.json()["plaques"]

        assigned_first = self._assign(first, self.table_a1)
        assigned_second = self._assign(second, self.table_a2)
        self.assertEqual(assigned_first.status_code, 200, assigned_first.text)
        self.assertEqual(assigned_second.status_code, 200, assigned_second.text)

        for plaque in (assigned_first.json(), assigned_second.json()):
            not_verified = self.client.put(
                f"/smart-plaques/{plaque['id']}/nfc",
                headers=_headers(self.owner_a),
                json={"installed": True},
            )
            self.assertEqual(not_verified.status_code, 409, not_verified.text)
            self.assertEqual(
                self.client.put(
                    f"/smart-plaques/{plaque['id']}/nfc",
                    headers=_headers(self.owner_a),
                    json={"written": True},
                ).status_code,
                200,
            )
            self.assertEqual(
                self.client.put(
                    f"/smart-plaques/{plaque['id']}/nfc",
                    headers=_headers(self.owner_a),
                    json={"verified": True},
                ).status_code,
                200,
            )
            installed = self.client.put(
                f"/smart-plaques/{plaque['id']}/nfc",
                headers=_headers(self.owner_a),
                json={"installed": True},
            )
            self.assertEqual(installed.status_code, 200, installed.text)
            self.assertEqual(installed.json()["status"], "installed")

        final = self.client.get(
            "/smart-plaque-requests",
            headers=_headers(self.owner_a),
        )
        self.assertEqual(final.status_code, 200, final.text)
        final_request = final.json()[0]
        self.assertEqual(final_request["status"], "completed")
        self.assertEqual(final_request["installed_count"], 2)
        self.assertEqual(
            [row["action"] for row in final_request["history"]],
            ["requested", "approved", "preparing", "shipped", "delivered", "completed"],
        )

    def test_request_is_tenant_scoped_and_can_be_cancelled_before_approval(self) -> None:
        created = self._request_plaques(quantity=1)
        self.assertEqual(created.status_code, 201, created.text)
        request_id = created.json()["id"]

        other_tenant = self.client.get(
            "/smart-plaque-requests",
            headers=_headers(self.owner_b),
        )
        self.assertEqual(other_tenant.status_code, 200, other_tenant.text)
        self.assertEqual(other_tenant.json(), [])
        other_confirm = self.client.post(
            f"/smart-plaque-requests/{request_id}/confirm-delivery",
            headers=_headers(self.owner_b),
        )
        self.assertEqual(other_confirm.status_code, 404, other_confirm.text)

        cancelled = self.client.post(
            f"/smart-plaque-requests/{request_id}/cancel",
            headers=_headers(self.owner_a),
        )
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json()["status"], "cancelled")
