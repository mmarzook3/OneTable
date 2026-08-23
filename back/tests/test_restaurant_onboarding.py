"""Platform provisioning and resumable restaurant-owner onboarding."""

from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from sqlmodel import select

from pg_client_mixin import PgClientTestCase

from app import models, security


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


def _owner_headers(user: models.User) -> dict[str, str]:
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


class TestRestaurantOnboarding(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        from app.settings import settings

        self._previous_base = settings.public_app_base_url
        settings.public_app_base_url = "http://127.0.0.1:4202"
        self.operator = models.User(
            email="one-table-onboarding-operator@amvara.de",
            hashed_password=security.get_password_hash("operator-test-password"),
            full_name="Scanaki Operator",
            role=models.UserRole.platform_operator,
            tenant_id=None,
            provider_id=None,
        )
        self.session.add(self.operator)
        self.session.commit()
        self.session.refresh(self.operator)

    def tearDown(self) -> None:
        from app.settings import settings

        settings.public_app_base_url = self._previous_base
        super().tearDown()

    def _provision(self) -> tuple[dict, models.Tenant, models.User]:
        response = self.client.post(
            "/platform/tenants",
            headers=_platform_headers(self.operator),
            json={
                "restaurant_name": "Onboarding Test Kitchen",
                "owner_name": "Taylor Owner",
                "owner_email": "onboarding-test-owner@amvara.de",
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        result = response.json()
        tenant = self.session.get(models.Tenant, result["tenant_id"])
        owner = self.session.exec(
            select(models.User).where(models.User.email == result["username"])
        ).one()
        self.assertIsNotNone(tenant)
        return result, tenant, owner

    def test_operator_provisions_one_time_credentials_and_setup_link(self) -> None:
        result, tenant, owner = self._provision()

        self.assertEqual(tenant.onboarding_status, "not_started")
        self.assertEqual(tenant.ordering_mode, "menu_only")
        self.assertTrue(owner.must_change_password)
        self.assertTrue(
            security.verify_password(result["temporary_password"], owner.hashed_password)
        )
        setup_url = urlparse(result["password_setup_url"])
        raw_token = parse_qs(setup_url.query)["token"][0]
        self.assertGreater(len(raw_token), 20)
        reset_rows = self.session.exec(
            select(models.PasswordResetToken).where(
                models.PasswordResetToken.user_id == owner.id
            )
        ).all()
        self.assertEqual(len(reset_rows), 1)

        duplicate = self.client.post(
            "/platform/tenants",
            headers=_platform_headers(self.operator),
            json={
                "restaurant_name": "Duplicate Kitchen",
                "owner_email": owner.email,
            },
        )
        self.assertEqual(duplicate.status_code, 409, duplicate.text)

    def test_owner_completes_resumable_setup(self) -> None:
        _, tenant, owner = self._provision()
        headers = _owner_headers(owner)

        status_response = self.client.get("/onboarding/status", headers=headers)
        self.assertEqual(status_response.status_code, 200, status_response.text)
        self.assertEqual(status_response.json()["status"], "in_progress")
        self.assertTrue(status_response.json()["must_change_password"])

        password_response = self.client.put(
            "/onboarding/password",
            headers=headers,
            json={"new_password": "permanent-owner-password"},
        )
        self.assertEqual(password_response.status_code, 200, password_response.text)
        self.assertFalse(password_response.json()["must_change_password"])
        self.session.refresh(owner)
        self.assertTrue(
            security.verify_password("permanent-owner-password", owner.hashed_password)
        )
        self.assertEqual(
            self.session.exec(
                select(models.PasswordResetToken).where(
                    models.PasswordResetToken.user_id == owner.id,
                    models.PasswordResetToken.used_at.is_(None),
                )
            ).all(),
            [],
        )

        business_response = self.client.put(
            "/onboarding/business",
            headers=headers,
            json={
                "restaurant_name": "The Easy Onboarding Pub",
                "business_type": "bar",
                "owner_name": "Taylor Owner",
                "business_email": "venue-onboarding@amvara.de",
                "phone": "+442071838750",
                "address": "1 High Street, London",
            },
        )
        self.assertEqual(business_response.status_code, 200, business_response.text)
        self.assertEqual(business_response.json()["current_step"], 2)

        operations_response = self.client.put(
            "/onboarding/operations",
            headers=headers,
            json={
                "days_open": ["monday", "tuesday", "friday", "saturday"],
                "opening_time": "11:00",
                "closing_time": "23:00",
            },
        )
        self.assertEqual(operations_response.status_code, 200, operations_response.text)
        self.assertEqual(operations_response.json()["current_step"], 3)

        tables_response = self.client.post(
            "/onboarding/tables",
            headers=headers,
            json={
                "floor_name": "Main",
                "table_prefix": "Table ",
                "table_count": 6,
                "seats_per_table": 4,
            },
        )
        self.assertEqual(tables_response.status_code, 200, tables_response.text)
        self.assertEqual(tables_response.json()["table_count"], 6)
        # Retrying the saved step is idempotent and does not duplicate tables.
        retry_tables = self.client.post(
            "/onboarding/tables",
            headers=headers,
            json={
                "floor_name": "Main",
                "table_prefix": "Table ",
                "table_count": 6,
                "seats_per_table": 4,
            },
        )
        self.assertEqual(retry_tables.status_code, 200, retry_tables.text)
        self.assertEqual(retry_tables.json()["table_count"], 6)

        starter_response = self.client.post(
            "/onboarding/starter-products",
            headers=headers,
            json={
                "products": [
                    {"name": "Coffee", "price_cents": 250, "enabled": True},
                    {"name": "Water", "price_cents": 150, "enabled": True},
                ]
            },
        )
        self.assertEqual(starter_response.status_code, 200, starter_response.text)
        progress_response = self.client.put(
            "/onboarding/progress",
            headers=headers,
            json={"current_step": 5},
        )
        self.assertEqual(progress_response.status_code, 200, progress_response.text)
        self.assertEqual(progress_response.json()["product_count"], 2)

        complete_response = self.client.post(
            "/onboarding/complete", headers=headers, json={}
        )
        self.assertEqual(complete_response.status_code, 200, complete_response.text)
        completed = complete_response.json()
        self.assertEqual(completed["status"], "completed")
        # No Stripe keys in this test, so customer ordering remains safely browse-only.
        self.assertEqual(completed["ordering_mode"], "menu_only")
        self.session.refresh(tenant)
        self.assertIsNotNone(tenant.onboarding_completed_at)

    def test_tenant_owner_cannot_provision_other_restaurants(self) -> None:
        _, _, owner = self._provision()
        response = self.client.post(
            "/platform/tenants",
            headers=_owner_headers(owner),
            json={
                "restaurant_name": "Unauthorised Restaurant",
                "owner_email": "unauthorised-owner@amvara.de",
            },
        )
        self.assertEqual(response.status_code, 403, response.text)
