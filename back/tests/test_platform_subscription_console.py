from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
import uuid

from sqlmodel import select

from pg_client_mixin import PgClientTestCase

from app import models, security
from app.platform_subscription_service import (
    apply_admin_action,
    billing_history,
    list_subscriptions,
    subscription_metrics,
    sync_stripe_plan,
)
from app.saas_billing import process_saas_stripe_event


def _platform_headers(user: models.User) -> dict[str, str]:
    token = security.create_access_token(
        {
            "sub": user.email,
            "tenant_id": None,
            "provider_id": None,
            "is_platform_operator": True,
            "token_version": user.token_version,
        },
        expires_delta=timedelta(minutes=30),
    )
    return {"Authorization": f"Bearer {token}"}


class TestPlatformSubscriptionConsole(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        suffix = uuid.uuid4().hex[:8]
        self.operator = models.User(
            email=f"subscription-operator-{suffix}@amvara.de",
            hashed_password=security.get_password_hash("operator-password"),
            role=models.UserRole.platform_operator,
        )
        self.active = models.Tenant(
            name=f"Active Restaurant {suffix}",
            email=f"active-{suffix}@amvara.de",
            saas_subscription_status="active",
            saas_plan_code="pro",
            saas_extra_tables=2,
            saas_stripe_customer_id=f"cus_{suffix}",
            saas_stripe_subscription_id=f"sub_{suffix}",
            saas_subscription_ends_at=datetime.now(timezone.utc) + timedelta(days=20),
        )
        self.overdue = models.Tenant(
            name=f"Overdue Restaurant {suffix}",
            saas_subscription_status="past_due",
            saas_plan_code="lite",
            saas_last_payment_failed_at=datetime.now(timezone.utc),
        )
        self.session.add(self.operator)
        self.session.add(self.active)
        self.session.add(self.overdue)
        self.session.commit()
        self.session.refresh(self.operator)
        self.session.refresh(self.active)
        self.session.refresh(self.overdue)

    def test_paginated_search_filters_metrics_and_endpoint(self) -> None:
        result = list_subscriptions(
            self.session,
            search=self.active.name,
            status_filter="active",
            page=1,
            page_size=10,
        )
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["tenant_id"], self.active.id)
        self.assertEqual(result["items"][0]["table_limit"], 22)
        self.assertTrue(result["items"][0]["stripe_customer_url"].endswith(self.active.saas_stripe_customer_id))

        overdue = list_subscriptions(self.session, health_filter="overdue")
        self.assertIn(self.overdue.id, [row["tenant_id"] for row in overdue["items"]])
        metrics = subscription_metrics(self.session)
        self.assertGreaterEqual(metrics["active_count"], 1)
        self.assertGreaterEqual(metrics["past_due_count"], 1)
        self.assertGreaterEqual(metrics["mrr_cents"], 3999 + 2 * 399)

        response = self.client.get(
            "/platform/subscriptions",
            headers=_platform_headers(self.operator),
            params={"search": self.active.name, "page": 1, "page_size": 5},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["total"], 1)
        metrics_response = self.client.get(
            "/platform/subscriptions/metrics",
            headers=_platform_headers(self.operator),
        )
        self.assertEqual(metrics_response.status_code, 200, metrics_response.text)
        self.assertIn("mrr_cents", metrics_response.json())

        history_response = self.client.get(
            f"/platform/tenants/{self.overdue.id}/billing-history",
            headers=_platform_headers(self.operator),
        )
        self.assertEqual(history_response.status_code, 200, history_response.text)
        self.assertFalse(history_response.json()["stripe_configured"])

    def test_admin_lifecycle_actions_are_audited(self) -> None:
        tenant = self.overdue
        with patch("app.platform_subscription_service.settings.stripe_secret_key", ""):
            apply_admin_action(self.session, tenant, action="activate")
            self.assertEqual(tenant.saas_subscription_status, "active")
            apply_admin_action(self.session, tenant, action="suspend")
            self.assertEqual(tenant.saas_subscription_status, "suspended")
            apply_admin_action(self.session, tenant, action="grandfather")
            self.assertEqual(tenant.saas_subscription_status, "grandfathered")
            apply_admin_action(self.session, tenant, action="cancel")
            self.assertEqual(tenant.saas_subscription_status, "canceled")
        events = self.session.exec(
            select(models.SaasSubscriptionEvent).where(
                models.SaasSubscriptionEvent.tenant_id == tenant.id
            ).order_by(models.SaasSubscriptionEvent.id)
        ).all()
        self.assertEqual(
            [event.event_type for event in events],
            ["admin_activate", "admin_suspend", "admin_grandfather", "admin_cancel"],
        )

    def test_plan_sync_updates_stripe_items_and_local_state(self) -> None:
        base_item = SimpleNamespace(id="si_base", price=SimpleNamespace(id="price_old"))
        extra_item = SimpleNamespace(id="si_extra", price=SimpleNamespace(id="price_extra"))
        subscription = SimpleNamespace(
            id=self.active.saas_stripe_subscription_id,
            customer=self.active.saas_stripe_customer_id,
            status="active",
            current_period_end=int((datetime.now(timezone.utc) + timedelta(days=20)).timestamp()),
            cancel_at_period_end=False,
            metadata={"tenant_id": str(self.active.id), "plan_code": "ultra"},
            items=SimpleNamespace(data=[base_item, extra_item]),
        )
        with (
            patch("app.platform_subscription_service.settings.stripe_secret_key", "sk_test_platform"),
            patch("app.platform_subscription_service.settings.saas_ultra_stripe_price_id", "price_ultra"),
            patch("app.platform_subscription_service.settings.saas_extra_table_stripe_price_id", "price_extra"),
            patch("app.platform_subscription_service.stripe.Subscription.retrieve", return_value=subscription),
            patch("app.platform_subscription_service.stripe.Subscription.modify", return_value=subscription) as modify,
        ):
            sync_stripe_plan(
                self.session,
                self.active,
                plan_code="ultra",
                extra_tables=4,
                proration_behavior="create_prorations",
            )
        self.assertEqual(self.active.saas_plan_code, "ultra")
        self.assertEqual(self.active.saas_extra_tables, 4)
        updates = modify.call_args.kwargs["items"]
        self.assertIn({"id": "si_base", "price": "price_ultra", "quantity": 1}, updates)
        self.assertIn({"id": "si_extra", "price": "price_extra", "quantity": 4}, updates)

    def test_invoice_webhooks_drive_failed_queue_revenue_and_idempotency(self) -> None:
        paid_event = {
            "id": f"evt_paid_{uuid.uuid4().hex}",
            "type": "invoice.paid",
            "data": {"object": {
                "id": "in_paid",
                "customer": self.active.saas_stripe_customer_id,
                "subscription": self.active.saas_stripe_subscription_id,
                "status": "paid",
                "amount_paid": 4797,
                "currency": "gbp",
            }},
        }
        first = process_saas_stripe_event(self.session, paid_event)
        second = process_saas_stripe_event(self.session, paid_event)
        self.assertTrue(first["handled"])
        self.assertTrue(second["handled"])
        paid_rows = self.session.exec(
            select(models.SaasSubscriptionEvent).where(
                models.SaasSubscriptionEvent.stripe_event_id == paid_event["id"]
            )
        ).all()
        self.assertEqual(len(paid_rows), 1)

        failed_event = {
            "id": f"evt_failed_{uuid.uuid4().hex}",
            "type": "invoice.payment_failed",
            "data": {"object": {
                "id": "in_failed",
                "customer": self.active.saas_stripe_customer_id,
                "subscription": self.active.saas_stripe_subscription_id,
                "status": "open",
                "amount_due": 4797,
                "currency": "gbp",
            }},
        }
        process_saas_stripe_event(self.session, failed_event)
        self.session.refresh(self.active)
        self.assertEqual(self.active.saas_subscription_status, "past_due")
        self.assertIsNotNone(self.active.saas_last_payment_failed_at)
        self.assertGreaterEqual(subscription_metrics(self.session)["revenue_total_cents"], 4797)

    def test_billing_history_sanitizes_stripe_objects(self) -> None:
        invoice = SimpleNamespace(
            id="in_1", number="INV-1", status="paid", amount_due=999, amount_paid=999,
            currency="gbp", created=1700000000, due_date=None,
            hosted_invoice_url="https://invoice.test/1", invoice_pdf="https://invoice.test/1.pdf", attempt_count=1,
        )
        payment = SimpleNamespace(
            id="pi_1", status="succeeded", amount=999, amount_received=999,
            currency="gbp", created=1700000000,
        )
        with (
            patch("app.platform_subscription_service.settings.stripe_secret_key", "sk_test_platform"),
            patch("app.platform_subscription_service.stripe.Invoice.list", return_value=SimpleNamespace(data=[invoice])),
            patch("app.platform_subscription_service.stripe.PaymentIntent.list", return_value=SimpleNamespace(data=[payment])),
        ):
            result = billing_history(self.session, self.active)
        self.assertEqual(result["invoices"][0]["id"], "in_1")
        self.assertEqual(result["payments"][0]["id"], "pi_1")
        self.assertNotIn("client_secret", result["payments"][0])
