"""
Test GET /public/tenants — unauthenticated tenant discovery (landing, picker).
"""
import unittest

from pg_client_mixin import PgClientTestCase

from app import models


class TestPublicTenantsList(PgClientTestCase):
    def setUp(self):
        super().setUp()
        self.real_tenant = models.Tenant(
            name="Real Customer Tenant",
            email="real-customer-test@amvara.de",
            is_demo=False,
        )
        tenant = models.Tenant(
            name="Scanaki Demo Restaurant",
            email="must-not-leak-on-landing@amvara.de",
            is_demo=True,
        )
        self.session.add(self.real_tenant)
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)
        self.tenant_id = tenant.id

    def test_list_public_tenants_returns_200_and_shape(self):
        response = self.client.get("/public/tenants")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertIsInstance(data, list)
        self.assertGreaterEqual(len(data), 1)
        match = next((t for t in data if t["id"] == self.tenant_id), None)
        self.assertIsNotNone(match, "Created tenant must appear in list")
        self.assertEqual(match["name"], "Scanaki Demo Restaurant")
        self.assertIsNone(match["email"])
        self.assertTrue(match["is_demo"])
        self.assertNotIn(self.real_tenant.id, {row["id"] for row in data})
        for key in (
            "id",
            "name",
            "is_demo",
            "logo_filename",
            "whatsapp",
            "take_away_table_token",
            "terms_of_service_url",
            "privacy_policy_url",
            "timezone",
            "reservation_max_guests_per_slot",
            "website",
        ):
            self.assertIn(key, match, f"TenantSummary must include {key!r}")

    def test_real_tenant_remains_available_by_direct_id(self):
        response = self.client.get(f"/public/tenants/{self.real_tenant.id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["name"], "Real Customer Tenant")
        self.assertFalse(response.json()["is_demo"])


if __name__ == "__main__":
    unittest.main()
