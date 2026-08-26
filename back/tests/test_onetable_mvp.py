from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from unittest.mock import patch

from sqlmodel import select

from pg_client_mixin import PgClientTestCase

from app import models, security
from app.onetable_ordering import ordering_availability
from app.security import get_password_hash
from app.tenant_payment_credentials import encrypt_payment_secret


def _bearer_headers(user: models.User) -> dict[str, str]:
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


class TestScanakiMvp(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tenant = models.Tenant(
            name="Scanaki Test Pub",
            ordering_mode="automatic",
            immediate_payment_required=True,
            require_kds_online=False,
            strict_fifo_kds=True,
            currency_code="GBP",
            timezone="Europe/London",
            stripe_publishable_key="pk_test_one_table",
            stripe_secret_key_encrypted=encrypt_payment_secret("sk_test_one_table"),
            stripe_webhook_secret_encrypted=encrypt_payment_secret("whsec_one_table"),
        )
        self.session.add(self.tenant)
        self.session.commit()
        self.session.refresh(self.tenant)

        self.owner = models.User(
            email="one-table-test@amvara.de",
            hashed_password=get_password_hash("test-password-strong"),
            full_name="Test Owner",
            tenant_id=self.tenant.id,
            role=models.UserRole.owner,
        )
        self.session.add(self.owner)
        floor = models.Floor(name="Main", tenant_id=self.tenant.id)
        self.session.add(floor)
        self.session.commit()
        self.session.refresh(self.owner)
        self.session.refresh(floor)

        self.table = models.Table(
            name="Table 12",
            tenant_id=self.tenant.id,
            floor_id=floor.id,
            is_active=False,
        )
        self.product = models.Product(
            name="Burger",
            price_cents=1295,
            tenant_id=self.tenant.id,
        )
        self.session.add(self.table)
        self.session.add(self.product)
        self.session.commit()
        self.session.refresh(self.table)
        self.session.refresh(self.product)

    def test_structured_allergens_and_sold_out_toggle(self) -> None:
        headers = _bearer_headers(self.owner)
        update = self.client.put(
            f"/products/{self.product.id}",
            headers=headers,
            json={
                "is_available": False,
                "allergens": ["milk", "eggs"],
                "dietary_tags": ["vegetarian"],
                "allergen_notes": "Prepared in a shared kitchen.",
                "description": "Freshly prepared burger",
            },
        )
        self.assertEqual(update.status_code, 200, update.text)
        self.assertFalse(update.json()["is_available"])
        self.assertEqual(update.json()["allergens"], ["eggs", "milk"])

        hidden_menu = self.client.get(f"/menu/{self.table.token}")
        self.assertEqual(hidden_menu.status_code, 200, hidden_menu.text)
        self.assertNotIn(self.product.id, [row["id"] for row in hidden_menu.json()["products"]])

        available = self.client.put(
            f"/products/{self.product.id}",
            headers=headers,
            json={"is_available": True},
        )
        self.assertEqual(available.status_code, 200, available.text)
        visible_menu = self.client.get(f"/menu/{self.table.token}")
        product = next(row for row in visible_menu.json()["products"] if row["id"] == self.product.id)
        self.assertEqual(product["allergens"], ["eggs", "milk"])
        self.assertEqual(product["dietary_tags"], ["vegetarian"])
        self.assertEqual(product["allergen_notes"], "Prepared in a shared kitchen.")

    def test_invalid_allergen_code_is_rejected(self) -> None:
        response = self.client.put(
            f"/products/{self.product.id}",
            headers=_bearer_headers(self.owner),
            json={"allergens": ["not-a-real-allergen"]},
        )
        self.assertEqual(response.status_code, 400, response.text)

    def _create_checkout(self, key: str = "checkout-test-0001") -> int:
        response = self.client.post(
            f"/menu/{self.table.token}/order",
            json={
                "items": [
                    {
                        "product_id": self.product.id,
                        "source": "product",
                        "quantity": 1,
                    }
                ],
                "session_id": "browser-session-1234",
                "customer_name": "Guest",
                "idempotency_key": key,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["payment_required"])
        return int(response.json()["order_id"])

    def _start_payment(self, order_id: int) -> None:
        fake_intent = SimpleNamespace(
            id=f"pi_{order_id}", client_secret=f"pi_{order_id}_secret", status="requires_payment_method"
        )
        with patch("stripe.PaymentIntent.create", return_value=fake_intent) as create:
            response = self.client.post(
                f"/orders/{order_id}/create-payment-intent",
                params={
                    "table_token": self.table.token,
                    "session_id": "browser-session-1234",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["amount"], 1295)
        self.assertEqual(create.call_args.kwargs["currency"], "gbp")
        self.assertEqual(create.call_args.kwargs["idempotency_key"], f"one-table-order-{self.tenant.id}-{order_id}")

    def _webhook_event(self, event_type: str, order_id: int) -> dict:
        return {
            "id": f"evt_{event_type}_{order_id}",
            "type": event_type,
            "data": {
                "object": {
                    "id": f"pi_{order_id}",
                    "status": "succeeded" if event_type == "payment_intent.succeeded" else "requires_payment_method",
                    "amount": 1295,
                    "currency": "gbp",
                    "metadata": {
                        "order_id": str(order_id),
                        "tenant_id": str(self.tenant.id),
                        "table_id": str(self.table.id),
                    },
                }
            },
        }

    def _signed_webhook(self, event: dict) -> tuple[bytes, str]:
        payload = json.dumps(event, separators=(",", ":")).encode("utf-8")
        timestamp = int(time.time())
        signature = hmac.new(
            b"whsec_one_table",
            f"{timestamp}.".encode("ascii") + payload,
            hashlib.sha256,
        ).hexdigest()
        return payload, f"t={timestamp},v1={signature}"

    def test_automatic_checkout_is_retry_safe_and_hidden_until_paid(self) -> None:
        order_id = self._create_checkout()
        duplicate_id = self._create_checkout()
        self.assertEqual(duplicate_id, order_id)

        headers = _bearer_headers(self.owner)
        hidden = self.client.get(
            "/orders", params={"kitchen_released_only": True}, headers=headers
        )
        self.assertEqual(hidden.status_code, 200, hidden.text)
        self.assertNotIn(order_id, [row["id"] for row in hidden.json()])

        self._start_payment(order_id)
        item = self.session.exec(
            select(models.OrderItem).where(models.OrderItem.order_id == order_id)
        ).first()
        assert item is not None
        locked = self.client.put(
            f"/menu/{self.table.token}/order/{order_id}/items/{item.id}",
            params={"session_id": "browser-session-1234"},
            json={"quantity": 2},
        )
        self.assertEqual(locked.status_code, 409, locked.text)

        event = self._webhook_event("payment_intent.succeeded", order_id)
        payload, signature = self._signed_webhook(event)
        with patch("app.main.publish_order_update") as publish:
            first = self.client.post(
                f"/payments/stripe/webhook/{self.tenant.id}",
                content=payload,
                headers={"Stripe-Signature": signature},
            )
            second = self.client.post(
                f"/payments/stripe/webhook/{self.tenant.id}",
                content=payload,
                headers={"Stripe-Signature": signature},
            )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["kitchen_released"])
        self.assertEqual(second.status_code, 200, second.text)
        self.assertFalse(second.json()["kitchen_released"])
        self.assertEqual(
            len([call for call in publish.call_args_list if call.args[1]["type"] == "new_order"]),
            1,
        )

        self.session.expire_all()
        order = self.session.get(models.Order, order_id)
        assert order is not None
        self.assertEqual(order.payment_state, "succeeded")
        self.assertIsNotNone(order.paid_at)
        self.assertIsNotNone(order.kitchen_released_at)

        visible = self.client.get(
            "/orders", params={"kitchen_released_only": True}, headers=headers
        )
        self.assertEqual(visible.status_code, 200, visible.text)
        self.assertIn(order_id, [row["id"] for row in visible.json()])

    def test_failed_and_cancelled_payments_never_reach_kitchen(self) -> None:
        cases = (
            ("payment_intent.payment_failed", "checkout-test-failed", "failed"),
            ("payment_intent.canceled", "checkout-test-cancelled", "cancelled"),
        )
        for event_type, idempotency_key, expected_state in cases:
            with self.subTest(event_type=event_type):
                order_id = self._create_checkout(idempotency_key)
                self._start_payment(order_id)
                event = self._webhook_event(event_type, order_id)
                with patch("stripe.Webhook.construct_event", return_value=event):
                    response = self.client.post(
                        f"/payments/stripe/webhook/{self.tenant.id}",
                        content=b"signed payload",
                        headers={"Stripe-Signature": "t=1,v1=test"},
                    )
                self.assertEqual(response.status_code, 200, response.text)
                self.session.expire_all()
                order = self.session.get(models.Order, order_id)
                assert order is not None
                self.assertEqual(order.payment_state, expected_state)
                self.assertIsNone(order.kitchen_released_at)

    def test_kitchen_heartbeat_automatically_gates_checkout(self) -> None:
        self.tenant.require_kds_online = True
        self.session.add(self.tenant)
        self.session.commit()
        blocked = ordering_availability(self.session, self.tenant)
        self.assertFalse(blocked["allowed"])
        self.assertEqual(blocked["code"], "KDS_OFFLINE")

        response = self.client.post(
            "/tenant/kitchen-devices/heartbeat",
            headers=_bearer_headers(self.owner),
            json={
                "device_key": "kitchen-tablet-00000001",
                "name": "Kitchen tablet",
                "display_route": "kitchen",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.session.expire_all()
        available = ordering_availability(self.session, self.tenant)
        self.assertTrue(available["allowed"])
        self.assertTrue(available["kds_online"])

    def test_pause_and_service_hours_are_enforced(self) -> None:
        self.tenant.ordering_paused = True
        self.tenant.ordering_pause_reason = "Kitchen is catching up."
        self.session.add(self.tenant)
        self.session.commit()
        paused = ordering_availability(self.session, self.tenant)
        self.assertEqual(paused["code"], "PAUSED")

        self.tenant.ordering_paused = False
        self.tenant.ordering_service_hours = {
            "monday": {"open": "11:00", "close": "12:00"}
        }
        self.session.add(self.tenant)
        self.session.commit()
        closed = ordering_availability(
            self.session,
            self.tenant,
            now=datetime(2026, 8, 24, 13, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(closed["code"], "OUTSIDE_SERVICE_HOURS")

    def test_table_qr_nfc_and_plaque_lifecycle(self) -> None:
        headers = _bearer_headers(self.owner)
        with patch(
            "app.main.settings.public_app_base_url",
            "https://orders.one-table.test",
        ):
            tables = self.client.get("/tables", headers=headers)
            self.assertEqual(tables.status_code, 200, tables.text)
            row = next(item for item in tables.json() if item["id"] == self.table.id)
            self.assertEqual(row["menu_url"], row["nfc_payload"])
            self.assertTrue(row["menu_url"].endswith(f"/menu/{self.table.token}"))

            renamed = self.client.put(
                f"/tables/{self.table.id}",
                headers=headers,
                json={"name": "Renamed Table 12"},
            )
            self.assertEqual(renamed.status_code, 200, renamed.text)
            self.assertEqual(renamed.json()["token"], self.table.token)

            pdf = self.client.get("/tables/plaque-contact-sheet.pdf", headers=headers)
            self.assertEqual(pdf.status_code, 200, pdf.text)
            self.assertEqual(pdf.headers["content-type"], "application/pdf")
            self.assertTrue(pdf.content.startswith(b"%PDF"))

            old_token = self.table.token
            rotated = self.client.post(f"/tables/{self.table.id}/rotate-token", headers=headers)
            self.assertEqual(rotated.status_code, 200, rotated.text)
            self.assertNotEqual(rotated.json()["token"], old_token)
            self.assertEqual(rotated.json()["plaque_status"], "needs_reprint")
            self.assertEqual(rotated.json()["menu_url"], rotated.json()["nfc_payload"])
            revoked = self.client.get(f"/menu/{old_token}")
            self.assertEqual(revoked.status_code, 404, revoked.text)

            other_tenant = models.Tenant(name="Other Scanaki Tenant")
            self.session.add(other_tenant)
            self.session.commit()
            self.session.refresh(other_tenant)
            other_table = models.Table(name="Private Table", tenant_id=other_tenant.id)
            self.session.add(other_table)
            self.session.commit()
            self.session.refresh(other_table)
            isolated = self.client.post(
                f"/tables/{other_table.id}/rotate-token",
                headers=headers,
            )
            self.assertEqual(isolated.status_code, 404, isolated.text)
