"""Apple PassKit + Google Wallet loyalty pass issuance and balance push-updates (#343).

Uses shared platform certs/issuer from env (see docs/0066-club-loyalty.md). Tenants can
disable issuance via loyalty_program.wallet_passes_enabled without affecting balance cards.
Never invent signing formats — PassKit PKCS#7 + Google Wallet API only.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import secrets
import subprocess
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from jose import jwt as jose_jwt
from sqlmodel import Session, select

from . import models
from .settings import settings

logger = logging.getLogger(__name__)

GOOGLE_WALLET_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer"
GOOGLE_WALLET_API = "https://walletobjects.googleapis.com/walletobjects/v1"
GOOGLE_SAVE_ORIGIN = "https://pay.google.com/gp/v/save/"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _path_ok(path: str) -> bool:
    p = (path or "").strip()
    return bool(p) and Path(p).is_file()


def apple_env_configured() -> bool:
    return bool(
        (getattr(settings, "loyalty_apple_pass_cert_path", "") or "").strip()
        and (getattr(settings, "loyalty_apple_pass_key_path", "") or "").strip()
        and (getattr(settings, "loyalty_apple_wwdr_cert_path", "") or "").strip()
        and (getattr(settings, "loyalty_apple_pass_type_id", "") or "").strip()
        and (getattr(settings, "loyalty_apple_team_id", "") or "").strip()
    )


def apple_files_ready() -> bool:
    return (
        apple_env_configured()
        and _path_ok(settings.loyalty_apple_pass_cert_path)
        and _path_ok(settings.loyalty_apple_pass_key_path)
        and _path_ok(settings.loyalty_apple_wwdr_cert_path)
    )


def google_env_configured() -> bool:
    return bool(
        (getattr(settings, "loyalty_google_issuer_id", "") or "").strip()
        and (getattr(settings, "loyalty_google_service_account_json", "") or "").strip()
    )


def google_files_ready() -> bool:
    return google_env_configured() and _path_ok(settings.loyalty_google_service_account_json)


def apns_configured() -> bool:
    return bool(
        _path_ok(getattr(settings, "loyalty_apple_apns_key_path", "") or "")
        and (getattr(settings, "loyalty_apple_apns_key_id", "") or "").strip()
        and (getattr(settings, "loyalty_apple_team_id", "") or "").strip()
    )


def tenant_wallet_enabled(program: models.LoyaltyProgram | None) -> bool:
    if program is None:
        return True
    return bool(getattr(program, "wallet_passes_enabled", True))


def wallet_pass_status(program: models.LoyaltyProgram | None = None) -> dict:
    """Operational status for Apple/Google Wallet."""
    apple_cfg = apple_env_configured()
    google_cfg = google_env_configured()
    apple_ok = apple_files_ready()
    google_ok = google_files_ready()
    tenant_ok = tenant_wallet_enabled(program)
    apple_avail = apple_ok and tenant_ok
    google_avail = google_ok and tenant_ok

    if apple_avail and google_avail:
        detail = "Apple Wallet and Google Wallet passes are available for this program."
    elif apple_avail:
        detail = (
            "Apple Wallet passes are available. Google Wallet requires issuer + service account "
            "(see docs/0066-club-loyalty.md)."
        )
    elif google_avail:
        detail = (
            "Google Wallet passes are available. Apple Wallet requires PassKit signing certificates "
            "(see docs/0066-club-loyalty.md)."
        )
    elif not tenant_ok and (apple_ok or google_ok):
        detail = (
            "Wallet pass issuance is disabled for this restaurant. Balance card link still works."
        )
    elif apple_cfg and not apple_ok:
        detail = (
            "Apple Wallet env is set but certificate files are missing on the server. "
            "Google: "
            + ("ready." if google_ok else "not configured.")
        )
    elif google_cfg and not google_ok:
        detail = (
            "Google Wallet env is set but service-account JSON is missing. "
            "Apple: "
            + ("ready." if apple_ok else "not configured.")
        )
    else:
        detail = (
            "Wallet pass issuance requires Apple PassKit signing certificates and/or a Google Wallet "
            "issuer + service account. Join and balance card work without them. "
            "See docs/0066-club-loyalty.md."
        )

    return {
        "apple_wallet_configured": apple_cfg,
        "google_wallet_configured": google_cfg,
        "apple_wallet_available": apple_avail,
        "google_wallet_available": google_avail,
        "detail": detail,
    }


def passkit_web_service_base_url() -> str:
    override = (getattr(settings, "loyalty_apple_web_service_base_url", "") or "").strip().rstrip("/")
    if override:
        return override
    base = (getattr(settings, "public_app_base_url", "") or "").strip().rstrip("/")
    root = (getattr(settings, "root_path", "") or "").strip().rstrip("/")
    if not base:
        return ""
    # Public app is the SPA; API is usually at {base}{root} when HAProxy mounts /api.
    return f"{base}{root}/public/passkit"


def _minimal_png(size: int = 29) -> bytes:
    """Tiny solid PNG for required PassKit icon assets (Pillow)."""
    from PIL import Image

    img = Image.new("RGBA", (size, size), (30, 90, 60, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def ensure_apple_identity(membership: models.LoyaltyMembership) -> None:
    """Assign serial + auth token once so PassKit can register/update."""
    if not getattr(membership, "apple_pass_serial", None):
        membership.apple_pass_serial = f"loy-{membership.tenant_id}-{membership.id}-{secrets.token_hex(4)}"
    if not getattr(membership, "apple_auth_token", None):
        membership.apple_auth_token = secrets.token_urlsafe(24)
    if not getattr(membership, "apple_pass_updated_tag", None):
        membership.apple_pass_updated_tag = secrets.token_hex(8)


def build_pass_json(
    *,
    membership: models.LoyaltyMembership,
    program: models.LoyaltyProgram,
    tenant: models.Tenant,
) -> dict[str, Any]:
    ensure_apple_identity(membership)
    mode = (program.mode or "points").strip().lower()
    label = "Points" if mode == "points" else "Stamps"
    web_base = passkit_web_service_base_url()
    pass_body: dict[str, Any] = {
        "formatVersion": 1,
        "passTypeIdentifier": settings.loyalty_apple_pass_type_id.strip(),
        "serialNumber": membership.apple_pass_serial,
        "teamIdentifier": settings.loyalty_apple_team_id.strip(),
        "organizationName": (tenant.name or "Scanaki")[:60],
        "description": (program.program_name or "Loyalty")[:100],
        "logoText": (program.program_name or "Club")[:30],
        "foregroundColor": "rgb(255, 255, 255)",
        "backgroundColor": "rgb(30, 90, 60)",
        "labelColor": "rgb(220, 230, 220)",
        "storeCard": {
            "primaryFields": [
                {
                    "key": "balance",
                    "label": label,
                    "value": str(int(membership.balance)),
                    "changeMessage": "%@ " + label.lower(),
                }
            ],
            "secondaryFields": [
                {
                    "key": "member",
                    "label": "Member",
                    "value": (membership.display_name or "")[:50],
                }
            ],
            "backFields": [
                {
                    "key": "card_url",
                    "label": "Balance card",
                    "value": f"{(settings.public_app_base_url or '').rstrip('/')}/loyalty/card/{membership.member_token}",
                }
            ],
        },
    }
    if web_base:
        pass_body["webServiceURL"] = web_base
        pass_body["authenticationToken"] = membership.apple_auth_token
    return pass_body


def build_pkpass_bytes(
    *,
    membership: models.LoyaltyMembership,
    program: models.LoyaltyProgram,
    tenant: models.Tenant,
) -> bytes:
    """Build a signed .pkpass ZIP (pass.json + manifest + PKCS#7 signature)."""
    if not apple_files_ready():
        raise RuntimeError("Apple Wallet certificates are not configured")

    pass_json = build_pass_json(membership=membership, program=program, tenant=tenant)
    files: dict[str, bytes] = {
        "pass.json": json.dumps(pass_json, separators=(",", ":")).encode("utf-8"),
        "icon.png": _minimal_png(29),
        "paula.r@example.org": _minimal_png(58),
        "logo.png": _minimal_png(160),
    }
    manifest = {
        name: hashlib.sha1(data).hexdigest() for name, data in files.items()  # noqa: S324
    }
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode("utf-8")

    # PassKit expects a PKCS#7 detached signature of manifest.json (SHA-1). Use OpenSSL
    # because modern cryptography rejects SHA-1 for PKCS7SignatureBuilder.
    signature = _openssl_sign_manifest(
        manifest_bytes,
        cert_path=settings.loyalty_apple_pass_cert_path.strip(),
        key_path=settings.loyalty_apple_pass_key_path.strip(),
        wwdr_path=settings.loyalty_apple_wwdr_cert_path.strip(),
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
        zf.writestr("manifest.json", manifest_bytes)
        zf.writestr("signature", signature)
    return buf.getvalue()


def _openssl_sign_manifest(
    manifest_bytes: bytes,
    *,
    cert_path: str,
    key_path: str,
    wwdr_path: str,
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="pkpass-") as tmp:
        manifest_path = Path(tmp) / "manifest.json"
        sig_path = Path(tmp) / "signature"
        manifest_path.write_bytes(manifest_bytes)
        cmd = [
            "openssl",
            "smime",
            "-binary",
            "-sign",
            "-certfile",
            wwdr_path,
            "-signer",
            cert_path,
            "-inkey",
            key_path,
            "-in",
            str(manifest_path),
            "-out",
            str(sig_path),
            "-outform",
            "DER",
            "-nodetach",
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode != 0:
            err = (proc.stderr or b"").decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"openssl smime sign failed: {err}")
        return sig_path.read_bytes()


def _google_sa() -> dict[str, Any]:
    path = settings.loyalty_google_service_account_json.strip()
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _google_access_token() -> str:
    sa = _google_sa()
    now = int(time.time())
    assertion = jose_jwt.encode(
        {
            "iss": sa["client_email"],
            "scope": GOOGLE_WALLET_SCOPE,
            "aud": "https://oauth2.googleapis.com/token",
            "iat": now,
            "exp": now + 3600,
        },
        sa["private_key"],
        algorithm="RS256",
    )
    resp = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def google_class_id(tenant_id: int) -> str:
    issuer = settings.loyalty_google_issuer_id.strip()
    return f"{issuer}.{tenant_id}_loyalty"


def google_object_id(tenant_id: int, membership_id: int) -> str:
    issuer = settings.loyalty_google_issuer_id.strip()
    return f"{issuer}.{tenant_id}_m{membership_id}"


def _ensure_google_class(
    *,
    token: str,
    program: models.LoyaltyProgram,
    tenant: models.Tenant,
) -> str:
    class_id = google_class_id(tenant.id)  # type: ignore[arg-type]
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    get = requests.get(f"{GOOGLE_WALLET_API}/loyaltyClass/{class_id}", headers=headers, timeout=30)
    if get.status_code == 200:
        return class_id
    body = {
        "id": class_id,
        "issuerName": (tenant.name or "Scanaki")[:60],
        "reviewStatus": "UNDER_REVIEW",
        "programName": (program.program_name or "Loyalty")[:60],
        "programLogo": {
            "sourceUri": {
                "uri": "https://scanaki.uk/favicon.ico",
            },
            "contentDescription": {
                "defaultValue": {"language": "en-US", "value": "Logo"},
            },
        },
    }
    create = requests.post(
        f"{GOOGLE_WALLET_API}/loyaltyClass",
        headers=headers,
        json=body,
        timeout=30,
    )
    if create.status_code not in (200, 409):
        create.raise_for_status()
    return class_id


def ensure_google_loyalty_object(
    session: Session,
    *,
    membership: models.LoyaltyMembership,
    program: models.LoyaltyProgram,
    tenant: models.Tenant,
) -> str | None:
    """Create Google Wallet loyalty object on join; return object id or None if unavailable."""
    if not google_files_ready() or not tenant_wallet_enabled(program):
        return None
    if getattr(membership, "google_loyalty_object_id", None):
        return membership.google_loyalty_object_id
    try:
        token = _google_access_token()
        class_id = _ensure_google_class(token=token, program=program, tenant=tenant)
        object_id = google_object_id(membership.tenant_id, membership.id)  # type: ignore[arg-type]
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        mode = (program.mode or "points").strip().lower()
        label = "POINTS" if mode == "points" else "STAMPS"
        body = {
            "id": object_id,
            "classId": class_id,
            "state": "ACTIVE",
            "accountId": membership.member_token[:20],
            "accountName": (membership.display_name or "Member")[:60],
            "loyaltyPoints": {
                "label": label,
                "balance": {"int": int(membership.balance)},
            },
        }
        create = requests.post(
            f"{GOOGLE_WALLET_API}/loyaltyObject",
            headers=headers,
            json=body,
            timeout=30,
        )
        if create.status_code == 409:
            # Already exists — adopt id.
            pass
        else:
            create.raise_for_status()
        membership.google_loyalty_object_id = object_id
        session.add(membership)
        session.flush()
        return object_id
    except Exception:
        logger.exception(
            "Google Wallet object create failed for membership %s", membership.id
        )
        return None


def google_save_url(object_id: str) -> str:
    """JWT 'Add to Google Wallet' save URL for an existing loyalty object."""
    sa = _google_sa()
    now = int(time.time())
    claims = {
        "iss": sa["client_email"],
        "aud": "google",
        "typ": "savetowallet",
        "iat": now,
        "payload": {"loyaltyObjects": [{"id": object_id}]},
    }
    token = jose_jwt.encode(claims, sa["private_key"], algorithm="RS256")
    return f"{GOOGLE_SAVE_ORIGIN}{token}"


def patch_google_balance(membership: models.LoyaltyMembership, program: models.LoyaltyProgram) -> bool:
    object_id = getattr(membership, "google_loyalty_object_id", None)
    if not object_id or not google_files_ready():
        return False
    try:
        token = _google_access_token()
        mode = (program.mode or "points").strip().lower()
        label = "POINTS" if mode == "points" else "STAMPS"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        body = {
            "loyaltyPoints": {
                "label": label,
                "balance": {"int": int(membership.balance)},
            },
        }
        resp = requests.patch(
            f"{GOOGLE_WALLET_API}/loyaltyObject/{object_id}",
            headers=headers,
            json=body,
            timeout=30,
        )
        resp.raise_for_status()
        return True
    except Exception:
        logger.exception("Google Wallet PATCH failed for %s", object_id)
        return False


def send_apns_pass_update(push_token: str) -> bool:
    """Notify device that a pass changed (empty APNs payload for PassKit)."""
    if not apns_configured():
        return False
    try:
        key_pem = Path(settings.loyalty_apple_apns_key_path).read_text(encoding="utf-8")
        now = int(time.time())
        token = jose_jwt.encode(
            {
                "iss": settings.loyalty_apple_team_id.strip(),
                "iat": now,
            },
            key_pem,
            algorithm="ES256",
            headers={
                "alg": "ES256",
                "kid": settings.loyalty_apple_apns_key_id.strip(),
            },
        )
        topic = settings.loyalty_apple_pass_type_id.strip()
        # Production APNs; sandbox would use api.sandbox.push.apple.com
        url = f"https://api.push.apple.com/3/device/{push_token}"
        headers = {
            "authorization": f"bearer {token}",
            "apns-topic": topic,
            "apns-push-type": "background",
            "apns-priority": "5",
        }
        # HTTP/2 required; httpx needs the optional h2 extra.
        import httpx

        with httpx.Client(http2=True, timeout=20.0) as client:
            resp = client.post(url, content=b"{}", headers=headers)
        if resp.status_code >= 300:
            logger.warning("APNs pass push failed status=%s body=%s", resp.status_code, resp.text[:200])
            return False
        return True
    except Exception:
        logger.exception("APNs pass push failed for token …%s", push_token[-8:])
        return False


def bump_apple_pass_tag(membership: models.LoyaltyMembership) -> None:
    membership.apple_pass_updated_tag = secrets.token_hex(8)
    membership.updated_at = _now()


def register_apple_device(
    session: Session,
    *,
    membership: models.LoyaltyMembership,
    device_library_identifier: str,
    push_token: str,
) -> None:
    device_library_identifier = device_library_identifier.strip()[:128]
    push_token = push_token.strip()[:255]
    existing = session.exec(
        select(models.LoyaltyAppleDevice).where(
            models.LoyaltyAppleDevice.membership_id == membership.id,
            models.LoyaltyAppleDevice.device_library_identifier == device_library_identifier,
        )
    ).first()
    if existing:
        existing.push_token = push_token
        existing.updated_at = _now()
        session.add(existing)
    else:
        session.add(
            models.LoyaltyAppleDevice(
                membership_id=membership.id,  # type: ignore[arg-type]
                device_library_identifier=device_library_identifier,
                push_token=push_token,
            )
        )
    session.flush()


def unregister_apple_device(
    session: Session,
    *,
    membership: models.LoyaltyMembership,
    device_library_identifier: str,
) -> None:
    row = session.exec(
        select(models.LoyaltyAppleDevice).where(
            models.LoyaltyAppleDevice.membership_id == membership.id,
            models.LoyaltyAppleDevice.device_library_identifier == device_library_identifier.strip(),
        )
    ).first()
    if row:
        session.delete(row)
        session.flush()


def apple_serials_updated_since(
    session: Session,
    *,
    device_library_identifier: str,
    pass_type_id: str,
    passes_updated_since: str | None,
) -> tuple[list[str], str]:
    """Return (serials, lastUpdated tag) for PassKit device registration list."""
    expected = (settings.loyalty_apple_pass_type_id or "").strip()
    if pass_type_id != expected:
        return [], ""
    devices = session.exec(
        select(models.LoyaltyAppleDevice).where(
            models.LoyaltyAppleDevice.device_library_identifier == device_library_identifier.strip()
        )
    ).all()
    serials: list[str] = []
    newest = ""
    since = (passes_updated_since or "").strip()
    for device in devices:
        membership = session.get(models.LoyaltyMembership, device.membership_id)
        if not membership or not membership.apple_pass_serial:
            continue
        tag = membership.apple_pass_updated_tag or ""
        # Opaque lastUpdated tag: include when never synced or tag changed.
        if since and tag == since:
            continue
        serials.append(membership.apple_pass_serial)
        if tag and tag > newest:
            newest = tag
    if not serials:
        return [], newest
    return serials, newest or secrets.token_hex(8)


def membership_by_apple_serial(
    session: Session, serial_number: str
) -> models.LoyaltyMembership | None:
    return session.exec(
        select(models.LoyaltyMembership).where(
            models.LoyaltyMembership.apple_pass_serial == serial_number
        )
    ).first()


def verify_apple_pass_auth(membership: models.LoyaltyMembership, authorization: str | None) -> bool:
    if not authorization or not membership.apple_auth_token:
        return False
    expected = f"ApplePass {membership.apple_auth_token}"
    return authorization.strip() == expected


def prepare_passes_on_join(
    session: Session,
    *,
    membership: models.LoyaltyMembership,
    program: models.LoyaltyProgram,
    tenant: models.Tenant,
) -> dict[str, Any]:
    """Assign Apple identity + create Google object when platform is ready."""
    status = wallet_pass_status(program)
    out: dict[str, Any] = {"wallet": status}
    if not tenant_wallet_enabled(program):
        return out
    if status["apple_wallet_available"]:
        ensure_apple_identity(membership)
        session.add(membership)
        session.flush()
        out["apple_pkpass_path"] = (
            f"/public/loyalty/members/{membership.member_token}/wallet/apple.pkpass"
        )
    if status["google_wallet_available"]:
        oid = ensure_google_loyalty_object(
            session, membership=membership, program=program, tenant=tenant
        )
        if oid:
            try:
                out["google_save_url"] = google_save_url(oid)
            except Exception:
                logger.exception("Google save URL JWT failed")
    return out


def notify_balance_changed(
    session: Session,
    *,
    membership: models.LoyaltyMembership,
    program: models.LoyaltyProgram | None = None,
) -> dict[str, Any]:
    """Push balance to Google + bump Apple tag and APNs (best-effort; never raises)."""
    result = {"google_patched": False, "apple_pushed": 0, "apple_tag_bumped": False}
    try:
        if program is None:
            program = session.get(models.LoyaltyProgram, membership.program_id)
        if not program or not tenant_wallet_enabled(program):
            return result
        if getattr(membership, "apple_pass_serial", None) or apple_files_ready():
            ensure_apple_identity(membership)
            bump_apple_pass_tag(membership)
            session.add(membership)
            session.flush()
            result["apple_tag_bumped"] = True
            devices = session.exec(
                select(models.LoyaltyAppleDevice).where(
                    models.LoyaltyAppleDevice.membership_id == membership.id
                )
            ).all()
            for device in devices:
                if send_apns_pass_update(device.push_token):
                    result["apple_pushed"] += 1
        if not getattr(membership, "google_loyalty_object_id", None) and google_files_ready():
            tenant = session.get(models.Tenant, membership.tenant_id)
            if tenant:
                ensure_google_loyalty_object(
                    session, membership=membership, program=program, tenant=tenant
                )
        if patch_google_balance(membership, program):
            result["google_patched"] = True
    except Exception:
        logger.exception("notify_balance_changed failed for membership %s", membership.id)
    return result
