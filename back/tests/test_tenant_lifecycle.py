"""Tenant data export and purge (owner-only)."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import timedelta

import unittest

from pg_client_mixin import PgClientTestCase
from sqlmodel import Session, select

from app import models, security
from app.db import engine


def _bearer_headers(user: models.User) -> dict[str, str]:
    data = {
        "sub": user.email,
        "tenant_id": user.tenant_id,
        "provider_id": getattr(user, "provider_id", None),
        "token_version": user.token_version,
    }
    token = security.create_access_token(data, expires_delta=timedelta(minutes=30))
    return {"Authorization": f"Bearer {token}"}


class TestTenantLifecycle(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        tenant = models.Tenant(name="Lifecycle Café")
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)
        self.tenant_id = tenant.id

        self.owner = models.User(
            email="tl-owner@test.local",
            hashed_password=security.get_password_hash("secret"),
            full_name="Owner O",
            tenant_id=self.tenant_id,
            role=models.UserRole.owner,
        )
        self.admin = models.User(
            email="tl-admin@test.local",
            hashed_password=security.get_password_hash("secret"),
            full_name="Admin A",
            tenant_id=self.tenant_id,
            role=models.UserRole.admin,
        )
        self.session.add(self.owner)
        self.session.add(self.admin)
        self.session.commit()
        self.session.refresh(self.owner)
        self.session.refresh(self.admin)

    def test_export_forbidden_for_admin(self) -> None:
        r = self.client.get("/tenant/data-export", headers=_bearer_headers(self.admin))
        self.assertEqual(r.status_code, 403, r.text)

    def test_export_zip_for_owner_contains_json(self) -> None:
        r = self.client.get("/tenant/data-export", headers=_bearer_headers(self.owner))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers.get("content-type", "").split(";")[0], "application/zip")
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        names = zf.namelist()
        self.assertIn("tenant-export.json", names)
        data = json.loads(zf.read("tenant-export.json").decode("utf-8"))
        self.assertEqual(data.get("export_version"), 1)
        self.assertEqual(data["tenant"]["name"], "Lifecycle Café")
        self.assertTrue(any(u.get("email") == "tl-owner@test.local" for u in data["users"]))

    def test_purge_wrong_name_rejected(self) -> None:
        r = self.client.post(
            "/tenant/purge",
            headers=_bearer_headers(self.owner),
            json={"confirm_tenant_name": "Wrong Name"},
        )
        self.assertEqual(r.status_code, 400, r.text)

    def test_purge_deletes_tenant(self) -> None:
        self.session.add(
            models.LoginEvent(
                user_id=self.owner.id,
                role=self.owner.role,
                tenant_id=self.tenant_id,
                login_scope="tenant",
            )
        )
        self.session.commit()
        r = self.client.post(
            "/tenant/purge",
            headers=_bearer_headers(self.owner),
            json={"confirm_tenant_name": "Lifecycle Café"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        # Use a fresh session so we assert the route committed, not just flushed in-request.
        with Session(engine) as verify_session:
            self.assertIsNone(verify_session.get(models.Tenant, self.tenant_id))
            self.assertIsNone(
                verify_session.exec(
                    select(models.User).where(models.User.id == self.owner.id)
                ).first()
            )


if __name__ == "__main__":
    unittest.main()
