"""Signed synthetic Stripe events; no Stripe requests or customer data."""
from datetime import datetime, timezone
import hashlib
import hmac
import json
from pathlib import Path
import time
from unittest.mock import patch

from sqlalchemy import text

from pg_client_mixin import PgClientTestCase
from app import models
from app.location_routes import location_analytics
from app.seeds.check_onetable_payment_reconciliation import reconciliation_issues
from app.tenant_payment_credentials import encrypt_payment_secret


class TestStripeRefundAccounting(PgClientTestCase):
    def setUp(self):
        super().setUp()
        self.tenant = models.Tenant(
            name="Synthetic refund tenant", currency_code="GBP",
            stripe_webhook_secret_encrypted=encrypt_payment_secret("whsec_refund_fixture"),
        )
        self.other = models.Tenant(
            name="Other synthetic tenant",
            stripe_webhook_secret_encrypted=encrypt_payment_secret("whsec_refund_fixture"),
        )
        self.session.add_all([self.tenant, self.other])
        self.session.flush()
        self.order = models.Order(
            tenant_id=self.tenant.id, requires_prepayment=True,
            payment_state="succeeded", payment_method="stripe",
            payment_amount_cents=1200, payment_currency="gbp",
            stripe_payment_intent_id=f"pi_fixture_{self.tenant.id}",
            paid_at=datetime.now(timezone.utc),
            kitchen_released_at=datetime.now(timezone.utc),
            status=models.OrderStatus.completed,
        )
        self.session.add(self.order)
        self.session.commit()
        self.publisher = patch("app.main.publish_order_update")
        self.publish = self.publisher.start()
        self.addCleanup(self.publisher.stop)

    def event(self, amount=300, **overrides):
        obj = {
            "id": "ch_fixture", "payment_intent": self.order.stripe_payment_intent_id,
            "amount": 1200, "amount_refunded": amount, "currency": "gbp",
            "metadata": {"tenant_id": str(self.tenant.id), "order_id": str(self.order.id)},
        }
        obj.update(overrides)
        return {"id": f"evt_fixture_{amount}", "type": "charge.refunded", "data": {"object": obj}}

    def post(self, event, tenant_id=None, signing_key=b"whsec_refund_fixture"):
        payload = json.dumps(event).encode()
        timestamp = int(time.time())
        signature = hmac.new(signing_key, str(timestamp).encode() + b"." + payload, hashlib.sha256).hexdigest()
        return self.client.post(
            f"/payments/stripe/webhook/{tenant_id or self.tenant.id}", content=payload,
            headers={"Stripe-Signature": f"t={timestamp},v1={signature}"},
        )

    def accept(self, event):
        response = self.post(event)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["handled"])
        self.session.refresh(self.order)

    def summary(self, tenant_id=None):
        return location_analytics(
            current_user=models.User(tenant_id=tenant_id or self.tenant.id),
            from_date=None, to_date=None, location_id=None, session=self.session,
        )

    def success(self):
        return {"id": "evt_success", "type": "payment_intent.succeeded", "data": {"object": {
            "id": self.order.stripe_payment_intent_id, "status": "succeeded",
            "amount": 1200, "currency": "gbp",
            "metadata": {"tenant_id": str(self.tenant.id), "order_id": str(self.order.id)},
        }}}

    def test_partial_duplicate_older_then_full_amounts_and_net(self):
        for amount in (300, 300, 100):
            self.accept(self.event(amount))
            self.assertEqual(self.order.refunded_amount_cents, 300)
            self.assertEqual(self.order.payment_state, "partially_refunded")
        summary = self.summary()
        for row in (summary["combined"], summary["by_location"][0]):
            self.assertEqual(row["gross_sales_cents"], 1200)
            self.assertEqual(row["refund_amount_cents"], 300)
            self.assertEqual(row["net_sales_cents"], 900)
        self.assertEqual(summary["by_location"][0]["refund_count"], 1)
        self.assertEqual(reconciliation_issues(self.session), [])
        for amount in (1200, 1200, 600):
            self.accept(self.event(amount))
            self.assertEqual(self.order.refunded_amount_cents, 1200)
            self.assertEqual(self.order.payment_state, "refunded")
            self.assertEqual(self.summary()["combined"]["net_sales_cents"], 0)

    def test_late_payment_events_preserve_refunds_and_release_timestamp(self):
        released = self.order.kitchen_released_at
        for amount in (300, 1200):
            self.accept(self.event(amount))
            self.accept(self.success())
            for kind in ("processing", "payment_failed", "canceled"):
                self.accept({"type": f"payment_intent.{kind}", "data": {"object": {
                    "id": self.order.stripe_payment_intent_id,
                }}})
            self.assertEqual(self.order.refunded_amount_cents, amount)
            self.assertEqual(self.order.payment_state, "refunded" if amount == 1200 else "partially_refunded")
            self.assertEqual(self.order.kitchen_released_at, released)
        self.assertFalse(any(call.args[1]["type"] == "new_order" for call in self.publish.call_args_list))

    def test_refund_before_success_does_not_release_fully_refunded_order(self):
        self.order.paid_at = None
        self.order.kitchen_released_at = None
        self.order.payment_state = "awaiting_payment"
        self.session.commit()
        self.accept(self.event(1200))
        self.accept(self.success())
        self.assertEqual(self.order.payment_state, "refunded")
        self.assertIsNotNone(self.order.paid_at)
        self.assertIsNone(self.order.kitchen_released_at)
        self.assertEqual(reconciliation_issues(self.session), [])
        self.assertFalse(any(call.args[1]["type"] == "new_order" for call in self.publish.call_args_list))

    def test_late_success_preserves_cancelled_and_existing_delivery_status(self):
        cases = (
            (models.OrderStatus.cancelled, False, False),
            (models.OrderStatus.cancelled, False, True),
            (models.OrderStatus.out_for_delivery, True, False),
        )
        for status, already_paid, refunded in cases:
            with self.subTest(status=status, already_paid=already_paid, refunded=refunded):
                self.order.status = status
                self.order.paid_at = datetime.now(timezone.utc) if already_paid else None
                self.order.kitchen_released_at = datetime.now(timezone.utc) if already_paid else None
                self.order.payment_state = "refunded" if refunded else (
                    "succeeded" if already_paid else "awaiting_payment"
                )
                self.order.refunded_amount_cents = 1200 if refunded else 0
                self.session.commit()
                self.publish.reset_mock()
                self.accept(self.success())
                self.assertEqual(self.order.status, status)
                self.assertIsNotNone(self.order.paid_at)
                self.assertFalse(any(call.args[1]["type"] == "new_order"
                                     for call in self.publish.call_args_list))
                if refunded:
                    self.assertEqual(self.order.payment_state, "refunded")
                    self.assertEqual(self.order.refunded_amount_cents, 1200)

    def test_partial_refund_before_success_releases_once(self):
        self.order.paid_at = None
        self.order.kitchen_released_at = None
        self.order.payment_state = "awaiting_payment"
        self.session.commit()
        self.accept(self.event(300))
        self.accept(self.success())
        self.accept(self.success())
        self.assertEqual(self.order.payment_state, "partially_refunded")
        self.assertIsNotNone(self.order.kitchen_released_at)
        self.assertEqual(sum(call.args[1]["type"] == "new_order" for call in self.publish.call_args_list), 1)

    def test_tenant_isolation_and_signature(self):
        response = self.post(self.event(), tenant_id=self.other.id)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["handled"])
        response = self.post(self.event(), signing_key=b"wrong_fixture_secret")
        self.assertEqual(response.status_code, 400)
        self.session.refresh(self.order)
        self.assertEqual(self.order.refunded_amount_cents, 0)
        self.assertEqual(self.summary(self.other.id)["combined"]["gross_sales_cents"], 0)

    def test_signed_other_tenant_events_are_ignored_without_mutation(self):
        self.session.refresh(self.order)
        before = (self.order.payment_state, self.order.refunded_amount_cents,
                  self.order.paid_at, self.order.kitchen_released_at)
        events = [self.success(), self.event()]
        for kind in ("processing", "payment_failed", "canceled"):
            event = self.success()
            event["type"] = f"payment_intent.{kind}"
            events.append(event)
        for event in events:
            with self.subTest(event_type=event["type"]):
                response = self.post(event, tenant_id=self.other.id)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertFalse(response.json()["handled"])
        self.session.refresh(self.order)
        self.assertEqual(before, (self.order.payment_state, self.order.refunded_amount_cents,
                                 self.order.paid_at, self.order.kitchen_released_at))
        self.publish.assert_not_called()
        self.assertEqual(self.session.execute(text(
            'SELECT count(*) FROM order_payment WHERE order_id=:id'
        ), {"id": self.order.id}).scalar_one(), 0)

    def test_foreign_ack_requires_valid_signature_and_consistent_binding(self):
        event = self.success()
        self.assertEqual(self.post(event, tenant_id=self.other.id,
                                   signing_key=b"wrong_fixture_secret").status_code, 400)
        for field, value in (("tenant_id", "invalid"), ("order_id", "invalid"),
                             ("order_id", "999999999"), ("order_id", None)):
            event = self.success()
            event["data"]["object"]["metadata"][field] = value
            self.assertEqual(self.post(event, tenant_id=self.other.id).status_code, 400)
        event = self.success()
        event["data"]["object"]["id"] = "pi_wrong_binding"
        self.assertEqual(self.post(event, tenant_id=self.other.id).status_code, 400)
        event = self.success()
        event["data"]["object"]["metadata"]["tenant_id"] = str(self.other.id)
        self.assertEqual(self.post(event).status_code, 400)
        self.publish.assert_not_called()

    def test_wrong_connect_account_is_not_ignored(self):
        self.other.stripe_payment_mode = "connect"
        self.other.stripe_connected_account_id = "acct_expected_fixture"
        self.session.commit()
        event = self.success()
        event["account"] = "acct_wrong_fixture"
        with patch("app.main.settings.stripe_guest_webhook_secret", "whsec_refund_fixture"):
            self.assertEqual(self.post(event, tenant_id=self.other.id).status_code, 400)
        self.publish.assert_not_called()

    def test_invalid_amount_currency_or_metadata_is_rejected(self):
        for overrides in (
            {"amount_refunded": -1}, {"amount_refunded": 1201},
            {"amount_refunded": "300"}, {"amount_refunded": None},
            {"amount": 1300}, {"currency": "usd"},
            {"metadata": {"tenant_id": str(self.other.id)}},
            {"metadata": {"order_id": "999999"}},
        ):
            with self.subTest(overrides=overrides):
                response = self.post(self.event(**overrides))
                self.assertEqual(response.status_code, 400, response.text)
        self.session.refresh(self.order)
        self.assertEqual(self.order.refunded_amount_cents, 0)

    def test_legacy_unknown_and_paid_cancelled_order_reporting(self):
        self.order.refunded_amount_cents = None
        self.order.payment_state = "refunded"
        self.order.status = models.OrderStatus.cancelled
        self.session.commit()
        summary = self.summary()["combined"]
        self.assertEqual(summary["unknown_refund_count"], 1)
        self.assertIsNone(summary["net_sales_cents"])
        self.assertEqual(summary["gross_sales_cents"], 1200)
        self.accept(self.event(300))
        self.assertEqual(self.order.payment_state, "partially_refunded")
        self.assertEqual(self.summary()["combined"]["net_sales_cents"], 900)

    def test_migration_preserves_unknown_history_and_is_replay_safe(self):
        self.session.execute(text("CREATE SCHEMA refund_migration_fixture"))
        self.session.execute(text("SET LOCAL search_path TO refund_migration_fixture, public"))
        self.session.execute(text('CREATE TABLE "order" (id INTEGER, payment_state TEXT)'))
        self.session.execute(text("INSERT INTO \"order\" VALUES (1, 'refunded'), (2, 'succeeded')"))
        migration = (Path(__file__).resolve().parents[1] / "migrations" / "20260907190000_order_refund_amount.sql").read_text()
        self.session.execute(text(migration))
        self.assertEqual(self.session.execute(text('SELECT refunded_amount_cents FROM "order" ORDER BY id')).scalars().all(), [None, 0])
        self.session.execute(text('UPDATE "order" SET refunded_amount_cents = 300 WHERE id = 1'))
        self.session.execute(text(migration))
        self.assertEqual(self.session.execute(text('SELECT refunded_amount_cents FROM "order" WHERE id = 1')).scalar_one(), 300)
