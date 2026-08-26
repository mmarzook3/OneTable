from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch
import uuid

from fastapi import HTTPException
from sqlmodel import select

from pg_client_mixin import PgClientTestCase

from app import models, security
from app.platform_pricing_service import pricing_console, publish_pricing
from app.platform_subscription_service import subscription_metrics, sync_stripe_plan
from app.saas_billing import (
    plan_config,
    plan_has_unlimited_ordering_points,
    tenant_monthly_cents,
    tenant_table_limit,
)


def _headers(user: models.User) -> dict[str, str]:
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


class TestPlatformPricingCatalog(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        suffix = uuid.uuid4().hex[:8]
        self.operator = models.User(
            email=f"pricing-operator-{suffix}@amvara.de",
            hashed_password=security.get_password_hash("operator-password"),
            role=models.UserRole.platform_operator,
        )
        self.customer = models.Tenant(
            name=f"Contract customer {suffix}",
            saas_subscription_status="active",
            saas_plan_code="lite",
            saas_extra_tables=1,
        )
        self.session.add(self.operator)
        self.session.add(self.customer)
        self.session.commit()
        self.session.refresh(self.operator)
        self.session.refresh(self.customer)

    def _body(self, **overrides) -> models.PlatformPricingPublish:
        values = {
            "name": "Lite",
            "description": "Small venues",
            "regular_price_cents": 5000,
            "offer_price_cents": 1500,
            "currency": "gbp",
            "included_tables": 3,
            "extra_table_price_cents": 450,
            "trial_days": 21,
            "offer_badge": "Summer deal",
            "is_featured": False,
            "is_public": True,
            "create_stripe_prices": False,
            "migration_mode": "new_customers_only",
        }
        values.update(overrides)
        return models.PlatformPricingPublish(**values)

    def test_console_and_public_config_use_database_catalog(self) -> None:
        console = pricing_console(self.session)
        self.assertEqual(
            [row["plan_code"] for row in console["plans"]],
            ["lite", "pro", "ultra", "pilot"],
        )
        pilot = next(row for row in console["plans"] if row["plan_code"] == "pilot")
        self.assertFalse(pilot["is_public"])
        self.assertTrue(pilot["ordering_points_unlimited"])
        public = plan_config(self.session)
        self.assertEqual(public["plans"][0]["price_cents"], 999)
        self.assertEqual(public["plans"][0]["compare_at_price_cents"], 3497)
        self.assertNotIn("stripe_regular_price_id", public["plans"][0])

        response = self.client.get("/saas/config")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["plans"]), 3)

        protected = self.client.get("/platform/pricing")
        self.assertIn(protected.status_code, (401, 403))
        allowed = self.client.get("/platform/pricing", headers=_headers(self.operator))
        self.assertEqual(allowed.status_code, 200, allowed.text)

    def test_internal_pilot_is_hidden_unlimited_and_enables_all_features(self) -> None:
        self.assertNotIn("pilot", [row["id"] for row in plan_config(self.session)["plans"]])
        self.customer.ui_modules = {"inventory": False, "users": False}
        self.customer.saas_stripe_subscription_id = None
        self.session.add(self.customer)
        self.session.commit()
        updated = sync_stripe_plan(
            self.session,
            self.customer,
            plan_code="pilot",
            extra_tables=99,
        )
        self.assertEqual(updated.saas_plan_code, "pilot")
        self.assertEqual(updated.saas_subscription_status, "grandfathered")
        self.assertEqual(updated.saas_extra_tables, 0)
        self.assertEqual(updated.saas_monthly_price_cents, 0)
        self.assertIsNone(updated.ui_modules)
        self.assertTrue(plan_has_unlimited_ordering_points(updated.saas_plan_code))
        self.assertEqual(tenant_table_limit(updated), 2_147_483_647)

        with self.assertRaises(HTTPException) as public_pilot:
            publish_pricing(
                self.session,
                "pilot",
                self._body(name="Pilot", is_public=True),
                self.operator,
            )
        self.assertEqual(public_pilot.exception.status_code, 400)

    def test_publish_updates_landing_and_preserves_existing_contract(self) -> None:
        result = publish_pricing(self.session, "lite", self._body(), self.operator)
        self.assertEqual(result["publication"]["version"], 2)
        public = plan_config(self.session)
        lite = next(row for row in public["plans"] if row["id"] == "lite")
        self.assertEqual(lite["price_cents"], 1500)
        self.assertEqual(lite["regular_price_cents"], 5000)
        self.assertEqual(lite["included_tables"], 3)
        self.session.refresh(self.customer)
        self.assertEqual(self.customer.saas_monthly_price_cents, 999)
        self.assertEqual(self.customer.saas_extra_table_unit_price_cents, 399)
        self.assertEqual(self.customer.saas_included_tables, 2)
        self.assertEqual(tenant_monthly_cents(self.customer, self.session), 1398)
        self.assertGreaterEqual(subscription_metrics(self.session)["mrr_cents"], 1398)

        active = self.session.exec(
            select(models.SaasPlanPricing).where(
                models.SaasPlanPricing.plan_code == "lite",
                models.SaasPlanPricing.is_active == True,
            )
        ).all()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0].version, 2)
        audit = self.session.exec(
            select(models.SaasPricingEvent).where(models.SaasPricingEvent.pricing_id == active[0].id)
        ).one()
        self.assertEqual(audit.migration_mode, "new_customers_only")

    def test_platform_publish_route_updates_public_endpoint(self) -> None:
        response = self.client.post(
            "/platform/pricing/lite/publish",
            headers=_headers(self.operator),
            json=self._body(name="Lite Route", offer_price_cents=1250).model_dump(mode="json"),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["publication"]["migration_mode"], "new_customers_only")
        public = self.client.get("/saas/config")
        self.assertEqual(public.status_code, 200, public.text)
        lite = next(row for row in public.json()["plans"] if row["id"] == "lite")
        self.assertEqual(lite["name"], "Lite Route")
        self.assertEqual(lite["price_cents"], 1250)

    def test_offer_schedule_and_visibility_drive_public_catalog(self) -> None:
        publish_pricing(
            self.session,
            "lite",
            self._body(
                offer_starts_at=datetime.now(timezone.utc) + timedelta(days=1),
                offer_ends_at=datetime.now(timezone.utc) + timedelta(days=5),
            ),
            self.operator,
        )
        lite = next(row for row in plan_config(self.session)["plans"] if row["id"] == "lite")
        self.assertFalse(lite["offer_active"])
        self.assertEqual(lite["price_cents"], 5000)
        self.assertIsNone(lite["compare_at_price_cents"])

        publish_pricing(self.session, "pro", self._body(name="Pro", is_public=False), self.operator)
        self.assertNotIn("pro", [row["id"] for row in plan_config(self.session)["plans"]])

    def test_validation_rejects_fake_discount_and_bad_stripe_ids(self) -> None:
        with self.assertRaises(HTTPException) as discount:
            publish_pricing(
                self.session,
                "lite",
                self._body(offer_price_cents=5000),
                self.operator,
            )
        self.assertEqual(discount.exception.status_code, 400)
        with self.assertRaises(HTTPException) as identifier:
            publish_pricing(
                self.session,
                "lite",
                self._body(stripe_regular_price_id="not-a-price"),
                self.operator,
            )
        self.assertEqual(identifier.exception.status_code, 400)

    def test_can_create_versioned_stripe_prices(self) -> None:
        product = type("Product", (), {"id": "prod_scanaki"})()
        prices = [
            type("Price", (), {"id": "price_regular_new"})(),
            type("Price", (), {"id": "price_offer_new"})(),
            type("Price", (), {"id": "price_extra_new"})(),
        ]
        with (
            patch("app.platform_pricing_service.settings.stripe_secret_key", "sk_test_scanaki"),
            patch("app.platform_pricing_service.stripe.Product.create", return_value=product),
            patch("app.platform_pricing_service.stripe.Price.create", side_effect=prices) as create_price,
        ):
            publish_pricing(
                self.session,
                "lite",
                self._body(create_stripe_prices=True),
                self.operator,
            )
        self.assertEqual(create_price.call_count, 3)
        current = self.session.exec(
            select(models.SaasPlanPricing).where(
                models.SaasPlanPricing.plan_code == "lite",
                models.SaasPlanPricing.is_active == True,
            )
        ).one()
        self.assertEqual(current.stripe_regular_price_id, "price_regular_new")
        self.assertEqual(current.stripe_offer_price_id, "price_offer_new")
        self.assertEqual(current.stripe_extra_table_price_id, "price_extra_new")
