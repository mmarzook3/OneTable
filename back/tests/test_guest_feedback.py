"""Guest feedback public POST and tenant list."""
import unittest
from datetime import date, time

from pg_client_mixin import PgClientTestCase
from sqlmodel import select

from app import models


class TestGuestFeedback(PgClientTestCase):
    def setUp(self):
        super().setUp()
        tenant = models.Tenant(
            name="T1",
            address="123 Main St",
            public_google_review_url="https://g.page/r/test-place/review",
            public_google_maps_url="https://maps.google.com/?q=Test",
        )
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)
        self.tenant_id = tenant.id
        res = models.Reservation(
            tenant_id=self.tenant_id,
            customer_name="A",
            customer_phone="+34123456789",
            reservation_date=date.today(),
            reservation_time=time(20, 0),
            party_size=2,
            status=models.ReservationStatus.finished,
            token="tok-test-1",
        )
        self.session.add(res)
        self.session.commit()
        self.session.refresh(res)
        self.res_id = res.id

    def test_public_tenant_includes_google_review_url(self):
        from app.settings import settings

        r = self.client.get(f"/public/tenants/{self.tenant_id}")
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual(data.get("public_google_review_url"), "https://g.page/r/test-place/review")
        self.assertEqual(data.get("public_google_maps_url"), "https://maps.google.com/?q=Test")
        self.assertIsNone(data.get("public_openstreetmap_url"))
        self.assertEqual(data.get("address"), "123 Main St")
        base = settings.public_app_base_url.rstrip("/")
        self.assertEqual(data.get("terms_of_service_url"), f"{base}/terms")
        self.assertEqual(data.get("privacy_policy_url"), f"{base}/privacy")

    def test_public_legal_urls_endpoint(self):
        from app.settings import settings

        prev_t = settings.public_terms_of_service_url
        prev_p = settings.public_privacy_policy_url
        settings.public_terms_of_service_url = "https://legal.example/tos"
        settings.public_privacy_policy_url = "https://legal.example/privacy"
        try:
            r = self.client.get("/public/legal-urls")
            self.assertEqual(r.status_code, 200, r.text)
            d = r.json()
            self.assertEqual(d.get("terms_of_service_url"), "https://legal.example/tos")
            self.assertEqual(d.get("privacy_policy_url"), "https://legal.example/privacy")
        finally:
            settings.public_terms_of_service_url = prev_t
            settings.public_privacy_policy_url = prev_p

    def test_public_legal_urls_fallback_to_app_base(self):
        from app.settings import settings

        prev_base = settings.public_app_base_url
        prev_t = settings.public_terms_of_service_url
        prev_p = settings.public_privacy_policy_url
        settings.public_app_base_url = "https://app.example"
        settings.public_terms_of_service_url = ""
        settings.public_privacy_policy_url = ""
        try:
            r = self.client.get("/public/legal-urls")
            self.assertEqual(r.status_code, 200, r.text)
            d = r.json()
            self.assertEqual(d.get("terms_of_service_url"), "https://app.example/terms")
            self.assertEqual(d.get("privacy_policy_url"), "https://app.example/privacy")
        finally:
            settings.public_app_base_url = prev_base
            settings.public_terms_of_service_url = prev_t
            settings.public_privacy_policy_url = prev_p

    def test_public_legal_urls_explicit_overrides_app_base(self):
        from app.settings import settings

        prev_base = settings.public_app_base_url
        prev_t = settings.public_terms_of_service_url
        prev_p = settings.public_privacy_policy_url
        settings.public_app_base_url = "https://wrong.example"
        settings.public_terms_of_service_url = "https://right.example/tos"
        settings.public_privacy_policy_url = "https://right.example/privacy"
        try:
            r = self.client.get("/public/legal-urls")
            self.assertEqual(r.status_code, 200, r.text)
            d = r.json()
            self.assertEqual(d.get("terms_of_service_url"), "https://right.example/tos")
            self.assertEqual(d.get("privacy_policy_url"), "https://right.example/privacy")
        finally:
            settings.public_app_base_url = prev_base
            settings.public_terms_of_service_url = prev_t
            settings.public_privacy_policy_url = prev_p

    def test_public_tenant_legal_urls_tenant_overrides_global(self):
        from app.settings import settings

        tenant = self.session.get(models.Tenant, self.tenant_id)
        assert tenant is not None
        tenant.public_terms_of_service_url = "https://tenant.example/terms"
        tenant.public_privacy_policy_url = None
        self.session.add(tenant)
        self.session.commit()

        prev_t = settings.public_terms_of_service_url
        prev_p = settings.public_privacy_policy_url
        settings.public_terms_of_service_url = "https://global.example/tos"
        settings.public_privacy_policy_url = "https://global.example/privacy"
        try:
            r = self.client.get(f"/public/tenants/{self.tenant_id}")
            self.assertEqual(r.status_code, 200, r.text)
            d = r.json()
            self.assertEqual(d.get("terms_of_service_url"), "https://tenant.example/terms")
            self.assertEqual(d.get("privacy_policy_url"), "https://global.example/privacy")
        finally:
            settings.public_terms_of_service_url = prev_t
            settings.public_privacy_policy_url = prev_p

    def test_submit_guest_feedback_minimal(self):
        r = self.client.post(
            f"/public/tenants/{self.tenant_id}/guest-feedback",
            json={"rating": 5, "comment": "Great"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json().get("ok"))
        row = self.session.exec(
            select(models.GuestFeedback)
            .where(models.GuestFeedback.tenant_id == self.tenant_id)
            .order_by(models.GuestFeedback.id.desc())
        ).first()
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.rating, 5)
        self.assertEqual(row.comment, "Great")

    def test_submit_with_reservation_token(self):
        r = self.client.post(
            f"/public/tenants/{self.tenant_id}/guest-feedback",
            json={"rating": 4, "reservation_token": "tok-test-1"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        row = self.session.exec(
            select(models.GuestFeedback)
            .where(models.GuestFeedback.tenant_id == self.tenant_id)
            .order_by(models.GuestFeedback.id.desc())
        ).first()
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.reservation_id, self.res_id)

    def test_invalid_reservation_token_400(self):
        r = self.client.post(
            f"/public/tenants/{self.tenant_id}/guest-feedback",
            json={"rating": 3, "reservation_token": "nope"},
        )
        self.assertEqual(r.status_code, 400, r.text)

    def test_invalid_reservation_token_localized_de(self):
        r = self.client.post(
            f"/public/tenants/{self.tenant_id}/guest-feedback",
            json={"rating": 3, "reservation_token": "nope"},
            headers={"Accept-Language": "de,en;q=0.5"},
        )
        self.assertEqual(r.status_code, 400, r.text)
        detail = r.json().get("detail")
        msg = detail.get("message") if isinstance(detail, dict) else detail
        self.assertIsInstance(msg, str)
        self.assertIn("Reservierungslink", msg)

    def test_get_public_tenant_404_localized_de(self):
        missing_id = self.tenant_id + 9_999_999
        r = self.client.get(
            f"/public/tenants/{missing_id}",
            headers={"Accept-Language": "de,en;q=0.5"},
        )
        self.assertEqual(r.status_code, 404, r.text)
        detail = r.json().get("detail")
        msg = detail.get("message") if isinstance(detail, dict) else detail
        self.assertIsInstance(msg, str)
        self.assertIn("Mandant", msg)


def _bearer_headers(user: models.User) -> dict[str, str]:
    from datetime import timedelta

    from app import security

    data = {
        "sub": user.email,
        "tenant_id": user.tenant_id,
        "provider_id": getattr(user, "provider_id", None),
        "token_version": user.token_version,
    }
    token = security.create_access_token(data, expires_delta=timedelta(minutes=30))
    return {"Authorization": f"Bearer {token}"}


class TestGuestFeedbackStaffAnalytics(PgClientTestCase):
    def setUp(self):
        super().setUp()
        from app import security

        tenant = models.Tenant(name="FB Analytics")
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)
        self.tenant_id = tenant.id

        other = models.Tenant(name="Other tenant FB")
        self.session.add(other)
        self.session.commit()
        self.session.refresh(other)
        self.other_tenant_id = other.id

        self.admin = models.User(
            email="fb-analytics-admin@test.local",
            hashed_password=security.get_password_hash("secret"),
            full_name="FB Admin",
            tenant_id=self.tenant_id,
            role=models.UserRole.admin,
        )
        self.session.add(self.admin)
        self.session.commit()
        self.session.refresh(self.admin)

        for rating, comment in ((5, "Great"), (4, None), (2, "Slow")):
            self.session.add(
                models.GuestFeedback(
                    tenant_id=self.tenant_id,
                    rating=rating,
                    comment=comment,
                    contact_email="guest@amvara.de" if rating == 5 else None,
                )
            )
        self.session.add(
            models.GuestFeedback(tenant_id=self.other_tenant_id, rating=1, comment="Other")
        )
        self.session.commit()

    def test_summary_aggregates_tenant_only(self):
        r = self.client.get(
            "/tenant/guest-feedback/summary",
            params={"days": 90},
            headers=_bearer_headers(self.admin),
        )
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual(data["total_count"], 3)
        self.assertEqual(data["average_rating"], 3.67)
        self.assertEqual(data["rating_counts"]["5"], 1)
        self.assertEqual(data["rating_counts"]["4"], 1)
        self.assertEqual(data["rating_counts"]["2"], 1)
        self.assertEqual(data["rating_counts"]["1"], 0)
        self.assertEqual(data["with_comment_count"], 2)
        self.assertEqual(data["with_contact_count"], 1)
        self.assertTrue(isinstance(data["by_day"], list))
        self.assertGreaterEqual(len(data["by_day"]), 1)

    def test_export_csv_tenant_scoped(self):
        r = self.client.get(
            "/tenant/guest-feedback/export",
            headers=_bearer_headers(self.admin),
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("text/csv", r.headers.get("content-type", ""))
        text = r.content.decode("utf-8-sig")
        lines = [ln for ln in text.strip().splitlines() if ln.strip()]
        self.assertTrue(lines[0].startswith("id,created_at,rating,"))
        # header + 3 tenant rows (not the other-tenant row)
        self.assertEqual(len(lines), 4)
        self.assertNotIn("Other", text)
        self.assertIn("Great", text)


if __name__ == "__main__":
    unittest.main()
