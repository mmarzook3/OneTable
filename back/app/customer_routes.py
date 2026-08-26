"""End-user customer accounts: register, login, email verify, profile, order history (#340)."""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import quote, urljoin

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from . import email_service as email_svc
from . import models
from . import security
from .api_errors import api_error_payload
from .contact_validation import normalize_email_address
from .db import get_session
from .language_service import normalize_language_code
from .messages import get_message
from .rate_limits import limiter
from .settings import settings

logger = logging.getLogger(__name__)

router = APIRouter()

_VERIFICATION_TOKEN_MAX_AGE = timedelta(hours=48)
_MIN_PASSWORD_LEN = 8


def _requested_language(
    request: Request,
    lang: str | None = Query(None, description="Language code (e.g. en, es)"),
) -> str:
    if lang:
        normalized = normalize_language_code(lang)
        if normalized:
            return normalized
    accept = request.headers.get("accept-language") or ""
    for part in accept.split(","):
        lang_part = part.strip().split(";")[0].strip()
        if not lang_part:
            continue
        normalized = normalize_language_code(lang_part)
        if normalized:
            return normalized
    return "en"


def _token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _customer_dict(c: models.Customer) -> dict:
    return {
        "id": c.id,
        "email": c.email,
        "full_name": c.full_name,
        "phone": c.phone,
        "business_name": c.business_name,
        "tax_id": c.tax_id,
        "address": c.address,
        "email_verified": bool(c.email_verified),
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


def _token_data_for_customer(c: models.Customer) -> dict:
    return {
        "sub": c.email,
        "customer_id": c.id,
        "token_version": c.token_version,
        "type": "customer",
    }


def _set_customer_cookie(response: Response, access_token: str) -> None:
    response.set_cookie(
        key=security.CUSTOMER_ACCESS_COOKIE,
        value=access_token,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
        max_age=settings.access_token_expire_minutes * 60,
    )


def _clear_customer_cookie(response: Response) -> None:
    response.delete_cookie(key=security.CUSTOMER_ACCESS_COOKIE, path="/")


def _verification_url(raw_token: str) -> str | None:
    base = (settings.public_app_base_url or "").strip().rstrip("/")
    if not base:
        return None
    return urljoin(base + "/", f"customer/verify-email?token={raw_token}")


async def _issue_and_send_verification(
    customer: models.Customer,
    session: Session,
    lang: str,
) -> bool:
    raw = secrets.token_urlsafe(32)
    customer.email_verification_token_hash = _token_hash(raw)
    customer.email_verification_sent_at = datetime.now(timezone.utc)
    customer.updated_at = datetime.now(timezone.utc)
    session.add(customer)
    session.commit()
    session.refresh(customer)

    verify_url = _verification_url(raw)
    if not verify_url:
        logger.warning(
            "customer verification email skipped: PUBLIC_APP_BASE_URL unset; customer_id=%s",
            customer.id,
        )
        return False
    if not email_svc.smtp_credentials_configured():
        logger.warning(
            "customer verification email skipped: SMTP not configured; customer_id=%s",
            customer.id,
        )
        return False
    return await email_svc.send_customer_verification_email(
        customer.email, verify_url, lang=lang
    )


@router.post("/register")
@limiter.limit(f"{getattr(settings, 'rate_limit_register_per_hour', 3)}/hour")
async def customer_register(
    request: Request,
    body: models.CustomerRegister,
    lang: str = Depends(_requested_language),
    session: Session = Depends(get_session),
) -> JSONResponse:
    try:
        email = normalize_email_address(body.email)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_error_payload("invalid_email", lang))
    if len(body.password) < _MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=400,
            detail=api_error_payload("customer_password_too_short", lang, min_length=_MIN_PASSWORD_LEN),
        )
    existing = session.exec(
        select(models.Customer).where(models.Customer.email == email)
    ).first()
    if existing:
        raise HTTPException(
            status_code=400, detail=api_error_payload("email_already_registered", lang)
        )

    customer = models.Customer(
        email=email,
        hashed_password=security.get_password_hash(body.password),
        full_name=(body.full_name.strip() if body.full_name else None) or None,
        email_verified=False,
    )
    session.add(customer)
    session.commit()
    session.refresh(customer)

    email_sent = await _issue_and_send_verification(customer, session, lang)
    return JSONResponse(
        status_code=status.HTTP_201_CREATED,
        content={
            "status": "created",
            "id": customer.id,
            "email": customer.email,
            "email_verified": False,
            "verification_email_sent": email_sent,
        },
    )


@router.post("/token")
@limiter.limit(f"{getattr(settings, 'rate_limit_login_per_15min', 5)}/15 minutes")
def customer_login(
    request: Request,
    body: models.CustomerLogin,
    lang: str = Depends(_requested_language),
    session: Session = Depends(get_session),
) -> JSONResponse:
    try:
        email = normalize_email_address(body.email)
    except ValueError:
        raise HTTPException(status_code=400, detail=api_error_payload("invalid_email", lang))
    customer = session.exec(
        select(models.Customer).where(models.Customer.email == email)
    ).first()
    if not customer or not security.verify_password(body.password, customer.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=api_error_payload("incorrect_username_or_password", lang),
        )

    access_token = security.create_access_token(
        data=_token_data_for_customer(customer),
        expires_delta=security.timedelta(minutes=settings.access_token_expire_minutes),
    )
    response = JSONResponse(
        content={
            "status": "success",
            "email_verified": bool(customer.email_verified),
        }
    )
    _set_customer_cookie(response, access_token)
    return response


@router.post("/logout")
def customer_logout() -> JSONResponse:
    response = JSONResponse(content={"status": "ok"})
    _clear_customer_cookie(response)
    return response


@router.get("/me")
def customer_me(
    current: Annotated[models.Customer, Depends(security.get_current_customer)],
) -> dict:
    return _customer_dict(current)


@router.get("/verify-email")
@limiter.limit(f"{getattr(settings, 'rate_limit_password_reset_per_hour', 5)}/hour")
def customer_verify_email(
    request: Request,
    token: str = Query(..., min_length=8, max_length=128),
    lang: str = Depends(_requested_language),
    session: Session = Depends(get_session),
) -> dict:
    th = _token_hash(token)
    customer = session.exec(
        select(models.Customer).where(models.Customer.email_verification_token_hash == th)
    ).first()
    if not customer:
        raise HTTPException(
            status_code=400, detail=api_error_payload("customer_verification_invalid", lang)
        )
    sent_at = customer.email_verification_sent_at
    if sent_at is not None:
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - sent_at > _VERIFICATION_TOKEN_MAX_AGE:
            raise HTTPException(
                status_code=400, detail=api_error_payload("customer_verification_expired", lang)
            )

    customer.email_verified = True
    customer.email_verification_token_hash = None
    customer.email_verification_sent_at = None
    customer.updated_at = datetime.now(timezone.utc)
    session.add(customer)
    session.commit()
    return {"status": "ok", "email": customer.email, "email_verified": True}


@router.post("/resend-verification")
@limiter.limit(f"{getattr(settings, 'rate_limit_password_reset_per_hour', 5)}/hour")
async def customer_resend_verification(
    request: Request,
    body: models.CustomerResendVerification,
    lang: str = Depends(_requested_language),
    session: Session = Depends(get_session),
) -> dict:
    """Always return ok to avoid email enumeration; send only when account is unverified."""
    msg = get_message("customer_verification_resent", lang)
    try:
        email = normalize_email_address(body.email)
    except ValueError:
        return {"status": "ok", "message": msg}

    customer = session.exec(
        select(models.Customer).where(models.Customer.email == email)
    ).first()
    if customer and not customer.email_verified:
        await _issue_and_send_verification(customer, session, lang)
    return {"status": "ok", "message": msg}


@router.post("/password-reset/request")
@limiter.limit(f"{getattr(settings, 'rate_limit_password_reset_per_hour', 5)}/hour")
async def customer_password_reset_request(
    request: Request,
    body: models.CustomerPasswordResetRequest,
    lang: str = Depends(_requested_language),
    session: Session = Depends(get_session),
) -> dict:
    """Request a customer reset link without revealing whether the account exists."""
    msg = get_message("password_reset_sent", lang)
    try:
        email = normalize_email_address(body.email)
    except ValueError:
        return {"status": "ok", "message": msg}
    base = (settings.public_app_base_url or "").strip().rstrip("/")
    if not base:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=api_error_payload("password_reset_not_configured", lang),
        )
    customer = session.exec(
        select(models.Customer).where(models.Customer.email == email)
    ).first()
    if customer is None:
        return {"status": "ok", "message": msg}
    raw = secrets.token_urlsafe(32)
    customer.password_reset_token_hash = _token_hash(raw)
    customer.password_reset_sent_at = datetime.now(timezone.utc)
    customer.updated_at = datetime.now(timezone.utc)
    session.add(customer)
    session.flush()
    reset_url = f"{base}/customer/reset-password?token={quote(raw, safe='')}"
    sent = await email_svc.send_password_reset_email(
        customer.email,
        reset_url,
        tenant=None,
        lang=lang,
    )
    if not sent:
        customer.password_reset_token_hash = None
        customer.password_reset_sent_at = None
        session.add(customer)
    session.commit()
    return {"status": "ok", "message": msg}


@router.post("/password-reset/confirm")
@limiter.limit(f"{getattr(settings, 'rate_limit_password_reset_per_hour', 5)}/hour")
def customer_password_reset_confirm(
    request: Request,
    body: models.CustomerPasswordResetConfirm,
    lang: str = Depends(_requested_language),
    session: Session = Depends(get_session),
) -> dict:
    token_hash = _token_hash(body.token.strip())
    customer = session.exec(
        select(models.Customer).where(
            models.Customer.password_reset_token_hash == token_hash
        )
    ).first()
    now = datetime.now(timezone.utc)
    sent_at = customer.password_reset_sent_at if customer else None
    if sent_at is not None and sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=timezone.utc)
    max_age = timedelta(minutes=settings.password_reset_token_expire_minutes)
    if customer is None or sent_at is None or now - sent_at > max_age:
        raise HTTPException(
            status_code=400,
            detail=api_error_payload("password_reset_invalid", lang),
        )
    customer.hashed_password = security.get_password_hash(body.new_password)
    customer.password_reset_token_hash = None
    customer.password_reset_sent_at = None
    customer.token_version = (customer.token_version or 0) + 1
    customer.updated_at = now
    session.add(customer)
    session.commit()
    return {"status": "ok"}


@router.get("/orders")
def customer_orders(
    current: Annotated[models.Customer, Depends(security.get_current_customer)],
    session: Session = Depends(get_session),
    limit: int = Query(50, ge=1, le=100),
) -> dict:
    """List orders linked to this end-user account (empty until public flows attach customer_id)."""
    rows = session.exec(
        select(models.Order)
        .where(
            models.Order.customer_id == current.id,
            models.Order.deleted_at.is_(None),
        )
        .order_by(models.Order.created_at.desc())  # type: ignore[union-attr]
        .limit(limit)
    ).all()
    orders = [
        {
            "id": o.id,
            "tenant_id": o.tenant_id,
            "status": o.status.value if hasattr(o.status, "value") else str(o.status),
            "order_channel": (
                o.order_channel.value
                if hasattr(o.order_channel, "value")
                else str(o.order_channel)
            ),
            "customer_name": o.customer_name,
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "paid_at": o.paid_at.isoformat() if o.paid_at else None,
        }
        for o in rows
    ]
    return {"orders": orders, "count": len(orders)}
