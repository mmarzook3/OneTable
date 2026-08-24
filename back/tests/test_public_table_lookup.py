"""Legacy public table lookup accepts opaque tokens without exposing printed names."""

import unittest

from pg_client_mixin import PgClientTestCase

from app import models


class TestPublicTableLookup(PgClientTestCase):
    def setUp(self):
        super().setUp()
        self.tenant = models.Tenant(name="Lookup Tenant A")
        self.session.add(self.tenant)
        self.session.commit()
        self.session.refresh(self.tenant)

        self.floor = models.Floor(name="Main", tenant_id=self.tenant.id)
        self.session.add(self.floor)
        self.session.commit()
        self.session.refresh(self.floor)

        # Avoid colliding with seeded demo tables named T01–T10 on shared dev DBs.
        self.table = models.Table(
            name="LU-SINGLE-38",
            tenant_id=self.tenant.id,
            floor_id=self.floor.id,
            is_active=True,
        )
        self.session.add(self.table)
        self.session.commit()
        self.session.refresh(self.table)

    def test_lookup_by_token(self):
        r = self.client.get("/public/table-lookup", params={"q": self.table.token})
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        self.assertEqual(b["table_token"], self.table.token)
        self.assertFalse(b["ambiguous"])
        self.assertEqual(b["choices"], [])

    def test_lookup_by_printed_name_is_rejected(self):
        r = self.client.get("/public/table-lookup", params={"q": "lu-single-38"})
        self.assertEqual(r.status_code, 404, r.text)

    def test_lookup_unknown_returns_404(self):
        r = self.client.get("/public/table-lookup", params={"q": "NO_SUCH_TABLE_XYZ"})
        self.assertEqual(r.status_code, 404, r.text)

    def test_same_name_across_tenants_does_not_disclose_choices(self):
        t2 = models.Tenant(name="Lookup Tenant B")
        self.session.add(t2)
        self.session.commit()
        self.session.refresh(t2)
        f2 = models.Floor(name="Main", tenant_id=t2.id)
        self.session.add(f2)
        self.session.commit()
        self.session.refresh(f2)
        tab2 = models.Table(
            name="LU-AMB-38",
            tenant_id=t2.id,
            floor_id=f2.id,
            is_active=True,
        )
        self.session.add(tab2)
        self.session.commit()
        self.session.refresh(tab2)

        self.table.name = "LU-AMB-38"
        self.session.add(self.table)
        self.session.commit()
        self.session.refresh(self.table)

        r = self.client.get("/public/table-lookup", params={"q": "lu-amb-38"})
        self.assertEqual(r.status_code, 404, r.text)
        self.assertNotIn(self.table.token, r.text)
        self.assertNotIn(tab2.token, r.text)
        self.assertNotIn("Lookup Tenant A", r.text)
        self.assertNotIn("Lookup Tenant B", r.text)


if __name__ == "__main__":
    unittest.main()
