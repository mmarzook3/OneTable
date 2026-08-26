from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, patch
import uuid

from pg_client_mixin import PgClientTestCase

from app import models, security
from app.platform_settings_service import (
    decrypt_platform_smtp_password,
    effective_platform_smtp_config,
    encrypt_platform_smtp_password,
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


class TestPlatformSettings(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        suffix = uuid.uuid4().hex[:8]
        self.operator = models.User(
            email=f"platformuser-{suffix}",
            hashed_password=security.get_password_hash("local-test-password"),
            role=models.UserRole.platform_operator,
        )
        self.session.add(self.operator)
        row = self.session.get(models.PlatformSettings, 1)
        if row is None:
            row = models.PlatformSettings(id=1)
        row.company_legal_name = None
        row.support_email = None
        row.contact_email = None
        row.phone = None
        row.address = None
        row.website_url = None
        row.company_number = None
        row.vat_number = None
        row.terms_url = None
        row.privacy_url = None
        row.smtp_host = None
        row.smtp_port = None
        row.smtp_use_tls = True
        row.smtp_auth_required = True
        row.smtp_user = None
        row.smtp_password_encrypted = None
        row.email_from = None
        row.email_from_name = None
        row.smtp_last_tested_at = None
        row.smtp_last_test_success = None
        row.smtp_last_test_message = None
        self.operator.recovery_email = None
        self.session.add(self.operator)
        self.session.add(row)
        self.session.commit()
        self.session.refresh(self.operator)

    def _body(self, **overrides) -> dict:
        body = {
            "operator_recovery_email": "platform-owner@scanaki.uk",
            "company_legal_name": "Scanaki Systems Ltd",
            "support_email": "support@scanaki.uk",
            "contact_email": "hello@scanaki.uk",
            "phone": "+44 20 0000 0000",
            "address": "1 Test Street, London",
            "website_url": "https://scanaki.uk",
            "company_number": "12345678",
            "vat_number": "GB123456789",
            "terms_url": "https://scanaki.uk/terms",
            "privacy_url": "https://scanaki.uk/privacy",
            "smtp_host": "smtp.scanaki.uk",
            "smtp_port": 587,
            "smtp_use_tls": True,
            "smtp_auth_required": True,
            "smtp_user": "mailer@scanaki.uk",
            "smtp_password": "smtp-local-test-secret",
            "clear_smtp_password": False,
            "email_from": "noreply@scanaki.uk",
            "email_from_name": "Scanaki",
        }
        body.update(overrides)
        return body

    def test_secret_round_trip_uses_encrypted_prefix(self) -> None:
        encrypted = encrypt_platform_smtp_password("smtp-local-test-secret")
        self.assertTrue(encrypted.startswith("platform-smtp:v1:"))
        self.assertNotIn("smtp-local-test-secret", encrypted)
        self.assertEqual(decrypt_platform_smtp_password(encrypted), "smtp-local-test-secret")

    def test_settings_are_protected_but_public_projection_is_safe(self) -> None:
        self.assertIn(self.client.get("/platform/settings").status_code, (401, 403))
        allowed = self.client.get("/platform/settings", headers=_headers(self.operator))
        self.assertEqual(allowed.status_code, 200, allowed.text)
        public = self.client.get("/platform/public-settings")
        self.assertEqual(public.status_code, 200, public.text)
        self.assertNotIn("smtp_host", public.json())
        self.assertNotIn("smtp_password", public.text)

    def test_update_masks_password_and_drives_public_legal_details(self) -> None:
        response = self.client.put(
            "/platform/settings",
            headers=_headers(self.operator),
            json=self._body(),
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["company_legal_name"], "Scanaki Systems Ltd")
        self.assertEqual(payload["operator_recovery_email"], "platform-owner@scanaki.uk")
        self.assertEqual(payload["smtp_password_masked"], "••••••••")
        self.assertTrue(payload["smtp_password_configured"])
        self.assertEqual(payload["smtp_source"], "database")
        self.assertNotIn("smtp-local-test-secret", response.text)
        row = self.session.get(models.PlatformSettings, 1)
        self.assertIsNotNone(row.smtp_password_encrypted)
        self.assertNotIn("smtp-local-test-secret", row.smtp_password_encrypted)
        self.assertEqual(effective_platform_smtp_config(self.session)["password"], "smtp-local-test-secret")

        public = self.client.get("/platform/public-settings").json()
        self.assertEqual(public["support_email"], "support@scanaki.uk")
        legal = self.client.get("/public/legal-urls").json()
        self.assertEqual(legal["terms_of_service_url"], "https://scanaki.uk/terms")
        self.assertEqual(legal["privacy_policy_url"], "https://scanaki.uk/privacy")

    def test_test_email_records_verified_connection_without_exposing_secret(self) -> None:
        saved = self.client.put(
            "/platform/settings",
            headers=_headers(self.operator),
            json=self._body(),
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        with patch(
            "app.platform_settings_service.aiosmtplib.send",
            new=AsyncMock(return_value=None),
        ) as send:
            tested = self.client.post(
                "/platform/settings/test-smtp",
                headers=_headers(self.operator),
                json={"recipient_email": "owner@scanaki.uk"},
            )
        self.assertEqual(tested.status_code, 200, tested.text)
        self.assertTrue(tested.json()["success"])
        self.assertEqual(send.await_count, 1)
        status = self.client.get("/platform/settings", headers=_headers(self.operator)).json()
        self.assertEqual(status["smtp_status"], "verified")
        self.assertTrue(status["smtp_last_test_success"])
        self.assertNotIn("smtp-local-test-secret", str(status))

    def test_ip_authenticated_relay_needs_no_saved_password(self) -> None:
        body = self._body(
            smtp_host="smtp-relay.gmail.com",
            smtp_auth_required=False,
            smtp_user=None,
            smtp_password=None,
            email_from="support@scanaki.uk",
        )
        saved = self.client.put(
            "/platform/settings",
            headers=_headers(self.operator),
            json=body,
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        payload = saved.json()
        self.assertFalse(payload["smtp_auth_required"])
        self.assertFalse(payload["smtp_password_configured"])
        self.assertEqual(payload["smtp_status"], "configured")
        self.assertEqual(payload["smtp_source"], "database")

        with patch(
            "app.platform_settings_service.aiosmtplib.send",
            new=AsyncMock(return_value=None),
        ) as send:
            tested = self.client.post(
                "/platform/settings/test-smtp",
                headers=_headers(self.operator),
                json={"recipient_email": "owner@scanaki.uk"},
            )
        self.assertEqual(tested.status_code, 200, tested.text)
        self.assertTrue(tested.json()["success"])
        kwargs = send.await_args.kwargs
        self.assertEqual(kwargs["hostname"], "smtp-relay.gmail.com")
        self.assertNotIn("username", kwargs)
        self.assertNotIn("password", kwargs)

    def test_environment_switch_requires_new_password(self) -> None:
        with (
            patch("app.platform_settings_service.settings.smtp_host", "smtp.gmail.com"),
            patch("app.platform_settings_service.settings.smtp_port", 587),
            patch("app.platform_settings_service.settings.smtp_use_tls", True),
            patch("app.platform_settings_service.settings.smtp_user", "env@scanaki.uk"),
            patch("app.platform_settings_service.settings.smtp_password", "environment-secret"),
            patch("app.platform_settings_service.settings.email_from", "env@scanaki.uk"),
            patch("app.platform_settings_service.settings.email_from_name", "Scanaki"),
        ):
            body = self._body(
                smtp_user="replacement@scanaki.uk",
                smtp_password=None,
            )
            response = self.client.put(
                "/platform/settings",
                headers=_headers(self.operator),
                json=body,
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("Enter the SMTP password", response.text)

    def test_platform_username_without_email_format_can_login(self) -> None:
        response = self.client.post(
            "/token?scope=platform",
            data={"username": self.operator.email.upper(), "password": "local-test-password"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        me = self.client.get("/platform/me", cookies=response.cookies)
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["email"], self.operator.email)

    def test_platform_operator_can_change_own_password_and_revoke_old_login(self) -> None:
        changed = self.client.post(
            "/platform/settings/change-password",
            headers=_headers(self.operator),
            json={
                "current_password": "local-test-password",
                "new_password": "different-local-test-password",
            },
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        old = self.client.post(
            "/token?scope=platform",
            data={"username": self.operator.email, "password": "local-test-password"},
        )
        self.assertEqual(old.status_code, 401, old.text)
        new = self.client.post(
            "/token?scope=platform",
            data={"username": self.operator.email, "password": "different-local-test-password"},
        )
        self.assertEqual(new.status_code, 200, new.text)
