"""Remember-me session lifetime, inactivity, and rotation behaviour."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import uuid

from jose import jwt

from pg_client_mixin import PgClientTestCase

from app import models, security
from app.settings import settings


class TestRememberedStaffSessions(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        suffix = uuid.uuid4().hex[:8]
        tenant = models.Tenant(name=f"Remember Session {suffix}")
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)
        self.user = models.User(
            email=f"remember-kitchen-{suffix}@test.local",
            hashed_password=security.get_password_hash("remember-test-password"),
            full_name="Remember Kitchen",
            tenant_id=tenant.id,
            role=models.UserRole.kitchen,
        )
        self.session.add(self.user)
        policy = self.session.get(models.PlatformSettings, 1)
        if policy is None:
            policy = models.PlatformSettings(id=1)
        policy.remember_session_days = 10
        policy.remember_inactivity_days = 5
        self.session.add(policy)
        self.session.commit()
        self.session.refresh(self.user)

    def _token_data(self) -> dict:
        return {
            "sub": self.user.email,
            "tenant_id": self.user.tenant_id,
            "provider_id": None,
            "token_version": self.user.token_version,
        }

    def test_remembered_login_sets_ten_day_rotating_cookie(self) -> None:
        response = self.client.post(
            "/token?remember_me=true",
            data={"username": self.user.email, "password": "remember-test-password"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["remembered"])
        self.assertEqual(response.json()["remember_session_days"], 10)
        cookie_header = response.headers.get("set-cookie", "")
        self.assertIn("refresh_token=", cookie_header)
        self.assertIn("Max-Age=864000", cookie_header)

        first_token = response.cookies.get("refresh_token")
        self.assertTrue(first_token)
        first_payload = jwt.decode(
            first_token,
            settings.refresh_secret_key,
            algorithms=[settings.algorithm],
        )
        self.assertTrue(first_payload["remember_me"])
        self.assertIn("session_started_at", first_payload)
        self.assertIn("iat", first_payload)

        refreshed = self.client.post("/refresh")
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        rotated_token = refreshed.cookies.get("refresh_token")
        self.assertTrue(rotated_token)
        rotated_payload = jwt.decode(
            rotated_token,
            settings.refresh_secret_key,
            algorithms=[settings.algorithm],
        )
        self.assertEqual(
            rotated_payload["session_started_at"],
            first_payload["session_started_at"],
        )
        self.assertGreaterEqual(rotated_payload["iat"], first_payload["iat"])

    def test_remembered_session_is_rejected_after_five_inactive_days(self) -> None:
        now = datetime.now(timezone.utc)
        stale = security.create_refresh_token(
            {
                **self._token_data(),
                "remember_me": True,
                "session_started_at": int((now - timedelta(days=6)).timestamp()),
                "iat": int((now - timedelta(days=6)).timestamp()),
            },
            expires_at=now + timedelta(days=4),
        )
        self.client.cookies.set("refresh_token", stale)
        response = self.client.post("/refresh")
        self.assertEqual(response.status_code, 401, response.text)
        self.assertIn("inactivity", response.json().get("detail", "").lower())

    def test_unchecked_remember_me_uses_session_cookie(self) -> None:
        response = self.client.post(
            "/token?remember_me=false",
            data={"username": self.user.email, "password": "remember-test-password"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["remembered"])
        refresh_cookie = next(
            value
            for value in response.headers.get_list("set-cookie")
            if value.startswith("refresh_token=")
        )
        self.assertNotIn("Max-Age=", refresh_cookie)

