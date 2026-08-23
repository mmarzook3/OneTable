"""Apple/Google Wallet loyalty pass issuance + balance push (#343)."""

from __future__ import annotations

import json
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pg_client_mixin import PgClientTestCase
from sqlmodel import select

from app import models, security
from app.settings import settings


def _bearer_headers(user: models.User) -> dict[str, str]:
    data = {
        "sub": user.email,
        "tenant_id": user.tenant_id,
        "provider_id": getattr(user, "provider_id", None),
        "token_version": user.token_version,
    }
    token = security.create_access_token(data, expires_delta=timedelta(minutes=30))
    return {"Authorization": f"Bearer {token}"}


def _write_self_signed_pem_pair(dir_path: Path, name: str) -> tuple[Path, Path]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "ES"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Scanaki Test"),
            x509.NameAttribute(NameOID.COMMON_NAME, name),
        ]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    cert_path = dir_path / f"{name}-cert.pem"
    key_path = dir_path / f"{name}-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


def _write_fake_google_sa(dir_path: Path) -> Path:
    """Minimal RSA service-account JSON for JWT signing in unit tests."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    path = dir_path / "google-sa.json"
    path.write_text(
        json.dumps(
            {
                "type": "service_account",
                "project_id": "test",
                "private_key_id": "abc",
                "private_key": pem,
                "client_email": "wallet-test@amvara.de",
                "client_id": "123",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        ),
        encoding="utf-8",
    )
    return path


class TestLoyaltyWallet(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tenant = models.Tenant(name="Wallet Cafe")
        self.session.add(self.tenant)
        self.session.commit()
        self.session.refresh(self.tenant)

        pwd = security.get_password_hash("x")
        self.admin = models.User(
            email="wallet-admin@amvara.de",
            hashed_password=pwd,
            full_name="Admin",
            role=models.UserRole.admin,
            tenant_id=self.tenant.id,
        )
        self.session.add(self.admin)
        self.session.commit()
        self.session.refresh(self.admin)

        self._tmpdir = tempfile.TemporaryDirectory()
        root = Path(self._tmpdir.name)
        self.pass_cert, self.pass_key = _write_self_signed_pem_pair(root, "pass")
        self.wwdr_cert, _ = _write_self_signed_pem_pair(root, "wwdr")
        self.google_sa = _write_fake_google_sa(root)

        self._prev = {
            "loyalty_apple_pass_type_id": settings.loyalty_apple_pass_type_id,
            "loyalty_apple_team_id": settings.loyalty_apple_team_id,
            "loyalty_apple_pass_cert_path": settings.loyalty_apple_pass_cert_path,
            "loyalty_apple_pass_key_path": settings.loyalty_apple_pass_key_path,
            "loyalty_apple_wwdr_cert_path": settings.loyalty_apple_wwdr_cert_path,
            "loyalty_google_issuer_id": settings.loyalty_google_issuer_id,
            "loyalty_google_service_account_json": settings.loyalty_google_service_account_json,
            "public_app_base_url": settings.public_app_base_url,
            "root_path": settings.root_path,
        }
        settings.loyalty_apple_pass_type_id = "pass.com.satisfecho.loyalty.test"
        settings.loyalty_apple_team_id = "TEAMTEST1"
        settings.loyalty_apple_pass_cert_path = str(self.pass_cert)
        settings.loyalty_apple_pass_key_path = str(self.pass_key)
        settings.loyalty_apple_wwdr_cert_path = str(self.wwdr_cert)
        settings.loyalty_google_issuer_id = "3388000000000000000"
        settings.loyalty_google_service_account_json = str(self.google_sa)
        settings.public_app_base_url = "https://satisfecho.test"
        settings.root_path = "/api"

    def tearDown(self) -> None:
        for key, val in self._prev.items():
            setattr(settings, key, val)
        self._tmpdir.cleanup()
        super().tearDown()

    def _enable_program(self, **overrides):
        body = {
            "enabled": True,
            "program_name": "Wallet Club",
            "mode": "points",
            "earn_units_per_order": 1,
            "redemption_threshold": 5,
            "reward_discount_cents": 200,
            "wallet_passes_enabled": True,
        }
        body.update(overrides)
        r = self.client.put(
            "/loyalty/program",
            json=body,
            headers=_bearer_headers(self.admin),
        )
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_wallet_status_available_when_certs_present(self):
        self._enable_program()
        join = self.client.post(
            f"/public/tenants/{self.tenant.id}/loyalty/join",
            json={"display_name": "Ada", "email": "ada.wallet@amvara.de"},
        )
        self.assertEqual(join.status_code, 200, join.text)
        token = join.json()["membership"]["member_token"]
        # Google create is mocked so join still succeeds without network
        with patch("app.loyalty_wallet._google_access_token", return_value="tok"), patch(
            "app.loyalty_wallet.requests.get"
        ) as gget, patch("app.loyalty_wallet.requests.post") as gpost:
            gget.return_value = MagicMock(status_code=200)
            gpost.return_value = MagicMock(status_code=200)
            gpost.return_value.raise_for_status = MagicMock()
            status = self.client.get(f"/public/loyalty/members/{token}/wallet")
        self.assertEqual(status.status_code, 200)
        body = status.json()
        self.assertTrue(body["apple_wallet_available"])
        self.assertTrue(body["google_wallet_available"])
        self.assertIn("apple_pkpass_path", body)

    def test_apple_pkpass_generation_happy_path(self):
        self._enable_program()
        with patch("app.loyalty_wallet.ensure_google_loyalty_object", return_value=None):
            join = self.client.post(
                f"/public/tenants/{self.tenant.id}/loyalty/join",
                json={"display_name": "Bob", "email": "bob.wallet@amvara.de"},
            )
        self.assertEqual(join.status_code, 200, join.text)
        token = join.json()["membership"]["member_token"]
        r = self.client.get(f"/public/loyalty/members/{token}/wallet/apple.pkpass")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers.get("content-type"), "application/vnd.apple.pkpass")
        self.assertGreater(len(r.content), 100)
        with zipfile.ZipFile(__import__("io").BytesIO(r.content)) as zf:
            names = set(zf.namelist())
            self.assertIn("pass.json", names)
            self.assertIn("manifest.json", names)
            self.assertIn("signature", names)
            pass_json = json.loads(zf.read("pass.json"))
            self.assertEqual(pass_json["passTypeIdentifier"], "pass.com.satisfecho.loyalty.test")
            self.assertEqual(pass_json["storeCard"]["primaryFields"][0]["value"], "0")

    def test_google_save_url_and_balance_patch(self):
        self._enable_program()
        mock_token = patch(
            "app.loyalty_wallet._google_access_token", return_value="ya29.test"
        )
        mock_get = patch("app.loyalty_wallet.requests.get")
        mock_post = patch("app.loyalty_wallet.requests.post")
        mock_patch = patch("app.loyalty_wallet.requests.patch")
        with mock_token, mock_get as gget, mock_post as gpost, mock_patch as gpatch:
            gget.return_value = MagicMock(status_code=404)
            created = MagicMock(status_code=200)
            created.raise_for_status = MagicMock()
            gpost.return_value = created
            patched = MagicMock(status_code=200)
            patched.raise_for_status = MagicMock()
            gpatch.return_value = patched

            join = self.client.post(
                f"/public/tenants/{self.tenant.id}/loyalty/join",
                json={"display_name": "Cara", "email": "cara.wallet@amvara.de"},
            )
            self.assertEqual(join.status_code, 200, join.text)
            self.assertIn("google_save_url", join.json())
            mid = join.json()["membership"]["id"]

            adj = self.client.post(
                f"/loyalty/memberships/{mid}/adjust",
                json={"delta_units": 3, "note": "test top-up"},
                headers=_bearer_headers(self.admin),
            )
            self.assertEqual(adj.status_code, 200, adj.text)
            self.assertTrue(gpatch.called)

    def test_passkit_register_and_update_list(self):
        self._enable_program()
        with patch("app.loyalty_wallet.ensure_google_loyalty_object", return_value=None):
            join = self.client.post(
                f"/public/tenants/{self.tenant.id}/loyalty/join",
                json={"display_name": "Dan", "email": "dan.wallet@amvara.de"},
            )
        token = join.json()["membership"]["member_token"]
        pk = self.client.get(f"/public/loyalty/members/{token}/wallet/apple.pkpass")
        self.assertEqual(pk.status_code, 200)
        self.session.expire_all()
        membership = self.session.exec(
            select(models.LoyaltyMembership).where(
                models.LoyaltyMembership.member_token == token
            )
        ).first()
        assert membership is not None
        serial = membership.apple_pass_serial
        auth = membership.apple_auth_token
        self.assertTrue(serial and auth)

        reg = self.client.post(
            f"/public/passkit/v1/devices/devlib1/registrations/"
            f"pass.com.satisfecho.loyalty.test/{serial}",
            json={"pushToken": "push-token-abc"},
            headers={"Authorization": f"ApplePass {auth}"},
        )
        self.assertIn(reg.status_code, (200, 201), reg.text)

        listed = self.client.get(
            "/public/passkit/v1/devices/devlib1/registrations/pass.com.satisfecho.loyalty.test"
        )
        self.assertEqual(listed.status_code, 200)
        self.assertIn(serial, listed.json()["serialNumbers"])

        with patch("app.loyalty_wallet.send_apns_pass_update", return_value=True) as apns:
            adj = self.client.post(
                f"/loyalty/memberships/{membership.id}/adjust",
                json={"delta_units": 2, "note": "earn"},
                headers=_bearer_headers(self.admin),
            )
            self.assertEqual(adj.status_code, 200, adj.text)
            self.assertTrue(apns.called)

        latest = self.client.get(
            f"/public/passkit/v1/passes/pass.com.satisfecho.loyalty.test/{serial}",
            headers={"Authorization": f"ApplePass {auth}"},
        )
        self.assertEqual(latest.status_code, 200)
        with zipfile.ZipFile(__import__("io").BytesIO(latest.content)) as zf:
            pass_json = json.loads(zf.read("pass.json"))
            self.assertEqual(pass_json["storeCard"]["primaryFields"][0]["value"], "2")

    def test_tenant_disable_wallet_falls_back(self):
        self._enable_program(wallet_passes_enabled=False)
        with patch("app.loyalty_wallet.ensure_google_loyalty_object", return_value=None):
            join = self.client.post(
                f"/public/tenants/{self.tenant.id}/loyalty/join",
                json={"display_name": "Eve", "email": "eve.wallet@amvara.de"},
            )
        self.assertEqual(join.status_code, 200)
        token = join.json()["membership"]["member_token"]
        self.assertFalse(join.json()["wallet"]["apple_wallet_available"])
        self.assertFalse(join.json()["wallet"]["google_wallet_available"])
        r = self.client.get(f"/public/loyalty/members/{token}/wallet/apple.pkpass")
        self.assertEqual(r.status_code, 503)
