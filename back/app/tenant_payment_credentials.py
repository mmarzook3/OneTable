"""Encrypted tenant payment credentials and Stripe account request options."""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from sqlmodel import Session, select

from . import models
from .settings import settings


_PREFIX = "enc:v1:"


def _fernet() -> Fernet:
    digest = hashlib.sha256(
        f"{settings.secret_key}:one-table:tenant-payments:v1".encode("utf-8")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_payment_secret(value: str) -> str:
    clean = value.strip()
    if not clean:
        raise ValueError("Payment secret cannot be empty")
    token = _fernet().encrypt(clean.encode("utf-8")).decode("ascii")
    return f"{_PREFIX}{token}"


def decrypt_payment_secret(value: str | None) -> str | None:
    if not value:
        return None
    if not value.startswith(_PREFIX):
        raise ValueError("Unsupported encrypted payment secret format")
    try:
        return _fernet().decrypt(value[len(_PREFIX) :].encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError) as exc:
        raise ValueError("Unable to decrypt payment secret") from exc


def tenant_stripe_secret(tenant: models.Tenant) -> str | None:
    """Resolve encrypted tenant key, with read-only fallback for pre-migration rows."""
    encrypted = getattr(tenant, "stripe_secret_key_encrypted", None)
    if encrypted:
        return decrypt_payment_secret(encrypted)
    legacy = getattr(tenant, "stripe_secret_key", None)
    return legacy.strip() if isinstance(legacy, str) and legacy.strip() else None


def tenant_stripe_webhook_secret(tenant: models.Tenant) -> str | None:
    return decrypt_payment_secret(getattr(tenant, "stripe_webhook_secret_encrypted", None))


def stripe_api_options(tenant: models.Tenant) -> dict[str, str]:
    """Arguments shared by Stripe SDK calls for tenant-key or Connect direct-charge mode."""
    mode = (getattr(tenant, "stripe_payment_mode", None) or "tenant_keys").strip().lower()
    if mode == "connect":
        account_id = (getattr(tenant, "stripe_connected_account_id", None) or "").strip()
        if not settings.stripe_secret_key or not account_id:
            raise ValueError("Stripe Connect is not fully configured")
        return {"api_key": settings.stripe_secret_key, "stripe_account": account_id}

    secret = tenant_stripe_secret(tenant) or settings.stripe_secret_key
    if not secret:
        raise ValueError("Stripe is not configured for this tenant")
    return {"api_key": secret}


def migrate_legacy_stripe_secrets(session: Session) -> int:
    """Encrypt legacy plaintext tenant Stripe keys and clear the plaintext column."""
    rows = session.exec(
        select(models.Tenant).where(
            models.Tenant.stripe_secret_key.is_not(None),
            models.Tenant.stripe_secret_key_encrypted.is_(None),
        )
    ).all()
    migrated = 0
    for tenant in rows:
        raw = (tenant.stripe_secret_key or "").strip()
        if not raw:
            tenant.stripe_secret_key = None
            session.add(tenant)
            continue
        tenant.stripe_secret_key_encrypted = encrypt_payment_secret(raw)
        tenant.stripe_secret_key = None
        session.add(tenant)
        migrated += 1
    if rows:
        session.commit()
    return migrated
