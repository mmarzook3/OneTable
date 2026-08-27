"""Scanaki platform identity and encrypted global SMTP configuration."""

from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone
from email.mime.text import MIMEText
from typing import Any
from urllib.parse import urlparse

import aiosmtplib
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlmodel import Session

from . import models
from .contact_validation import normalize_email_address
from .db import engine
from .settings import settings


_PREFIX = "platform-smtp:v1:"
_MASK = "••••••••"


def _fernet() -> Fernet:
    digest = hashlib.sha256(
        f"{settings.secret_key}:scanaki:platform-smtp:v1".encode("utf-8")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_platform_smtp_password(value: str) -> str:
    clean = value.strip()
    if not clean:
        raise ValueError("SMTP password cannot be empty")
    token = _fernet().encrypt(clean.encode("utf-8")).decode("ascii")
    return f"{_PREFIX}{token}"


def decrypt_platform_smtp_password(value: str | None) -> str | None:
    if not value:
        return None
    if not value.startswith(_PREFIX):
        raise ValueError("Unsupported platform SMTP secret")
    try:
        return _fernet().decrypt(value[len(_PREFIX) :].encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError) as exc:
        raise ValueError("Unable to decrypt platform SMTP secret") from exc


def get_platform_settings(session: Session, *, create: bool = True) -> models.PlatformSettings | None:
    row = session.get(models.PlatformSettings, 1)
    if row is None and create:
        row = models.PlatformSettings(id=1)
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def _clean(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    return cleaned or None


def _email(value: str | None, label: str) -> str | None:
    cleaned = _clean(value)
    if not cleaned:
        return None
    try:
        return normalize_email_address(cleaned)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {label}") from exc


def _url(value: str | None, label: str) -> str | None:
    cleaned = _clean(value)
    if not cleaned:
        return None
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{label} must be a full http(s) URL")
    return cleaned


def _environment_smtp() -> dict[str, Any]:
    return {
        "host": settings.smtp_host,
        "port": settings.smtp_port,
        "use_tls": settings.smtp_use_tls,
        "auth_required": True,
        "user": settings.smtp_user,
        "password": settings.smtp_password,
        "from_email": settings.email_from,
        "from_name": settings.email_from_name,
        "source": "environment" if settings.smtp_user and settings.smtp_password else "not_configured",
    }


def effective_platform_smtp_config(
    session: Session | None = None,
) -> dict[str, Any]:
    owns_session = session is None
    db_session = session or Session(engine)
    try:
        row = get_platform_settings(db_session, create=False)
        if row and (row.smtp_password_encrypted or (row.smtp_host and not row.smtp_auth_required)):
            return {
                "host": row.smtp_host or settings.smtp_host,
                "port": row.smtp_port or settings.smtp_port,
                "use_tls": row.smtp_use_tls,
                "auth_required": row.smtp_auth_required,
                "user": row.smtp_user or "",
                "password": decrypt_platform_smtp_password(row.smtp_password_encrypted) or "",
                "from_email": row.email_from or settings.email_from,
                "from_name": row.email_from_name or settings.email_from_name,
                "source": "database",
            }
        return _environment_smtp()
    finally:
        if owns_session:
            db_session.close()


def _legal_fallback(path: str, configured: str | None) -> str | None:
    if _clean(configured):
        return _clean(configured)
    base = (settings.public_app_base_url or "").strip().rstrip("/")
    return f"{base}/{path}" if base else None


def public_platform_settings(session: Session) -> dict[str, Any]:
    row = get_platform_settings(session, create=False)
    return {
        "company_legal_name": row.company_legal_name if row else None,
        "support_email": row.support_email if row else None,
        "contact_email": row.contact_email if row else None,
        "phone": row.phone if row else None,
        "address": row.address if row else None,
        "website_url": row.website_url if row else None,
        "company_number": row.company_number if row else None,
        "vat_number": row.vat_number if row else None,
        "terms_url": _legal_fallback(
            "terms",
            (row.terms_url if row else None) or settings.public_terms_of_service_url,
        ),
        "privacy_url": _legal_fallback(
            "privacy",
            (row.privacy_url if row else None) or settings.public_privacy_policy_url,
        ),
        "remember_session_days": row.remember_session_days if row else 10,
        "remember_inactivity_days": row.remember_inactivity_days if row else 5,
    }


def platform_settings_payload(
    session: Session,
    operator: models.User | None = None,
) -> dict[str, Any]:
    row = get_platform_settings(session)
    assert row is not None
    smtp = effective_platform_smtp_config(session)
    auth_required = bool(smtp.get("auth_required", True))
    configured = bool(
        smtp.get("host")
        and smtp.get("from_email")
        and (not auth_required or (smtp.get("user") and smtp.get("password")))
    )
    password_configured = bool(smtp.get("user") and smtp.get("password"))
    if row.smtp_last_test_success is True:
        status = "verified"
    elif row.smtp_last_test_success is False:
        status = "failed"
    elif configured:
        status = "configured"
    else:
        status = "not_configured"
    return {
        "operator_recovery_email": operator.recovery_email if operator else None,
        **public_platform_settings(session),
        "smtp_host": row.smtp_host or smtp.get("host") or "",
        "smtp_port": row.smtp_port or smtp.get("port") or 587,
        "smtp_use_tls": row.smtp_use_tls if row.smtp_password_encrypted else bool(smtp.get("use_tls", True)),
        "smtp_auth_required": auth_required,
        "smtp_user": row.smtp_user or smtp.get("user") or "",
        "smtp_password_masked": _MASK if password_configured else "",
        "smtp_password_configured": password_configured,
        "smtp_source": smtp.get("source"),
        "email_from": row.email_from or smtp.get("from_email") or "",
        "email_from_name": row.email_from_name or smtp.get("from_name") or "Scanaki",
        "smtp_status": status,
        "smtp_last_tested_at": row.smtp_last_tested_at.isoformat()
        if row.smtp_last_tested_at
        else None,
        "smtp_last_test_success": row.smtp_last_test_success,
        "smtp_last_test_message": row.smtp_last_test_message,
        "updated_at": row.updated_at.isoformat(),
    }


def update_platform_settings(
    session: Session,
    body: models.PlatformSettingsUpdate,
    operator: models.User,
) -> dict[str, Any]:
    row = get_platform_settings(session)
    assert row is not None
    previous_smtp = (
        row.smtp_host,
        row.smtp_port,
        row.smtp_use_tls,
        row.smtp_auth_required,
        row.smtp_user,
        row.smtp_password_encrypted,
        row.email_from,
        row.email_from_name,
    )
    smtp_host = _clean(body.smtp_host)
    smtp_user = _clean(body.smtp_user)
    smtp_auth_required = bool(body.smtp_auth_required)
    operator_recovery_email = _email(body.operator_recovery_email, "recovery email")
    sender_email = _email(body.email_from, "sender email")
    sender_name = _clean(body.email_from_name)
    new_password = _clean(body.smtp_password)
    if body.remember_inactivity_days > body.remember_session_days:
        raise HTTPException(
            status_code=400,
            detail="Inactivity sign-out cannot be longer than the remembered session",
        )
    if not row.smtp_password_encrypted and not new_password and not body.clear_smtp_password:
        differs_from_environment = any(
            (
                smtp_host not in (None, settings.smtp_host),
                body.smtp_port not in (None, settings.smtp_port),
                bool(body.smtp_use_tls) != bool(settings.smtp_use_tls),
                smtp_user not in (None, settings.smtp_user or None),
                sender_email not in (None, settings.email_from),
                sender_name not in (None, settings.email_from_name),
            )
        )
        if differs_from_environment and smtp_auth_required:
            raise HTTPException(
                status_code=400,
                detail="Enter the SMTP password when replacing environment-managed email settings",
            )
    will_have_database_password = bool(
        new_password or (row.smtp_password_encrypted and not body.clear_smtp_password)
    )
    if will_have_database_password and (not smtp_host or not smtp_user or not sender_email):
        raise HTTPException(
            status_code=400,
            detail="SMTP host, username and sender email are required with a saved password",
        )
    if not smtp_auth_required and (not smtp_host or not sender_email):
        raise HTTPException(
            status_code=400,
            detail="SMTP host and sender email are required for an IP-authenticated relay",
        )
    row.company_legal_name = _clean(body.company_legal_name)
    row.support_email = _email(body.support_email, "support email")
    row.contact_email = _email(body.contact_email, "contact email")
    row.phone = _clean(body.phone)
    row.address = _clean(body.address)
    row.website_url = _url(body.website_url, "Website URL")
    row.company_number = _clean(body.company_number)
    row.vat_number = _clean(body.vat_number)
    row.terms_url = _url(body.terms_url, "Terms URL")
    row.privacy_url = _url(body.privacy_url, "Privacy URL")
    row.smtp_host = smtp_host
    row.smtp_port = body.smtp_port
    row.smtp_use_tls = bool(body.smtp_use_tls)
    row.smtp_auth_required = smtp_auth_required
    row.smtp_user = smtp_user if smtp_auth_required else None
    row.email_from = sender_email
    row.email_from_name = sender_name
    row.remember_session_days = body.remember_session_days
    row.remember_inactivity_days = body.remember_inactivity_days
    if body.clear_smtp_password or not smtp_auth_required:
        row.smtp_password_encrypted = None
    elif new_password:
        row.smtp_password_encrypted = encrypt_platform_smtp_password(body.smtp_password or "")
    current_smtp = (
        row.smtp_host,
        row.smtp_port,
        row.smtp_use_tls,
        row.smtp_auth_required,
        row.smtp_user,
        row.smtp_password_encrypted,
        row.email_from,
        row.email_from_name,
    )
    if current_smtp != previous_smtp:
        row.smtp_last_tested_at = None
        row.smtp_last_test_success = None
        row.smtp_last_test_message = None
    row.updated_by_user_id = operator.id
    row.updated_at = datetime.now(timezone.utc)
    operator.recovery_email = operator_recovery_email
    session.add(operator)
    session.add(row)
    session.commit()
    session.refresh(row)
    return platform_settings_payload(session, operator)


async def test_platform_smtp(
    session: Session,
    recipient_email: str | None,
) -> dict[str, Any]:
    row = get_platform_settings(session)
    assert row is not None
    cfg = effective_platform_smtp_config(session)
    recipient = _email(
        recipient_email
        or row.contact_email
        or row.support_email
        or cfg.get("from_email")
        or cfg.get("user"),
        "test recipient email",
    )
    now = datetime.now(timezone.utc)
    success = False
    auth_required = bool(cfg.get("auth_required", True))
    configured = bool(
        cfg.get("host")
        and cfg.get("from_email")
        and (not auth_required or (cfg.get("user") and cfg.get("password")))
    )
    if not configured:
        message = "SMTP delivery is not configured."
    elif not recipient:
        message = "Add a valid test recipient, contact email or support email."
    else:
        test_message = MIMEText(
            "This confirms that the Scanaki platform SMTP configuration is working.",
            "plain",
            "utf-8",
        )
        test_message["From"] = (
            f"{cfg['from_name']} <{cfg['from_email']}>"
            if cfg.get("from_name")
            else str(cfg.get("from_email") or cfg.get("user"))
        )
        test_message["To"] = recipient
        test_message["Subject"] = "Scanaki SMTP test"
        try:
            kwargs: dict[str, Any] = {
                "hostname": cfg["host"],
                "port": int(cfg["port"]),
            }
            if auth_required:
                kwargs["username"] = cfg["user"]
                kwargs["password"] = cfg["password"]
            if int(cfg["port"]) == 465:
                kwargs["use_tls"] = True
            else:
                kwargs["start_tls"] = bool(cfg["use_tls"])
            await aiosmtplib.send(test_message, **kwargs)
            success = True
            message = f"Test email sent successfully to {recipient}."
        except aiosmtplib.SMTPAuthenticationError:
            message = "Authentication failed. Check the SMTP username and app password."
        except Exception:
            message = "Connection failed. Check the SMTP host, port, TLS setting and firewall."
    row.smtp_last_tested_at = now
    row.smtp_last_test_success = success
    row.smtp_last_test_message = message[:500]
    session.add(row)
    session.commit()
    return {
        "success": success,
        "message": message,
        "tested_at": now.isoformat(),
        "status": "verified" if success else "failed",
    }
