"""Platform operator portal — SaaS metrics and tenant oversight for platform admins."""

from datetime import datetime, timedelta, timezone
import hashlib
import secrets
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlmodel import Session, select

from . import models, security
from .contact_validation import normalize_email_address
from .db import get_session
from .email_service import send_restaurant_invitation_email
from .saas_billing import (
    initial_status_for_new_tenant,
    normalize_plan_code,
    tenant_table_limit,
    plan_monthly_cents,
    stripe_customer_dashboard_url,
)
from .security import get_current_user
from .settings import settings
from .tenant_ui_modules import new_tenant_ui_modules_stored
from .tenant_payment_credentials import tenant_stripe_secret, tenant_stripe_webhook_secret
from .platform_subscription_service import (
    apply_admin_action,
    billing_history,
    list_subscriptions,
    subscription_metrics,
    sync_stripe_plan,
)

router = APIRouter()

_TENANT_LIST_LIMIT = 100


def _require_platform_operator(
    current_user: Annotated[models.User, Depends(get_current_user)],
) -> models.User:
    if current_user.role != models.UserRole.platform_operator:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Platform operator account required",
        )
    if current_user.tenant_id is not None or current_user.provider_id is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Platform operator account required",
        )
    return current_user


def _count_for_tenant(session: Session, model: type, tenant_id: int) -> int:
    value = session.exec(
        select(func.count()).select_from(model).where(model.tenant_id == tenant_id)  # type: ignore[arg-type]
    ).one()
    return int(value or 0)


def _owner_for_tenant(session: Session, tenant_id: int) -> models.User | None:
    return session.exec(
        select(models.User)
        .where(
            models.User.tenant_id == tenant_id,
            models.User.role == models.UserRole.owner,
        )
        .order_by(models.User.id)  # type: ignore[arg-type]
        .limit(1)
    ).first()


def _tenant_summary(session: Session, tenant: models.Tenant) -> models.PlatformTenantSummary:
    tenant_id = tenant.id
    if tenant_id is None:
        raise ValueError("Tenant id is required")

    owner = _owner_for_tenant(session, tenant_id)

    return models.PlatformTenantSummary(
        id=tenant_id,
        name=tenant.name,
        created_at=tenant.created_at,
        owner_email=owner.email if owner else None,
        owner_name=owner.full_name if owner else None,
        tenant_email=tenant.email,
        tenant_phone=tenant.phone,
        product_count=_count_for_tenant(session, models.Product, tenant_id),
        table_count=_count_for_tenant(session, models.Table, tenant_id),
        user_count=_count_for_tenant(session, models.User, tenant_id),
        order_count=_count_for_tenant(session, models.Order, tenant_id),
        reservation_count=_count_for_tenant(session, models.Reservation, tenant_id),
        onboarding_status=tenant.onboarding_status,
        onboarding_step=tenant.onboarding_step,
        saas_plan_code=normalize_plan_code(tenant.saas_plan_code),
        saas_extra_tables=max(0, int(tenant.saas_extra_tables or 0)),
        table_limit=tenant_table_limit(tenant),
        invitation_sent_at=tenant.invitation_sent_at,
        invitation_last_error=tenant.invitation_last_error,
        subscription_status=tenant.saas_subscription_status,
        trial_ends_at=tenant.saas_trial_ends_at,
        renewal_at=tenant.saas_subscription_ends_at,
        cancel_at_period_end=tenant.saas_cancel_at_period_end,
        stripe_customer_id=tenant.saas_stripe_customer_id,
        stripe_subscription_id=tenant.saas_stripe_subscription_id,
        stripe_customer_url=stripe_customer_dashboard_url(tenant.saas_stripe_customer_id),
        last_payment_failed_at=tenant.saas_last_payment_failed_at,
        monthly_cents=(
            plan_monthly_cents(tenant.saas_plan_code, tenant.saas_extra_tables)
            if tenant.saas_subscription_status == "active"
            else 0
        ),
    )


def _tenant_detail(session: Session, tenant: models.Tenant) -> models.PlatformTenantDetail:
    tenant_id = tenant.id
    if tenant_id is None:
        raise ValueError("Tenant id is required")

    summary = _tenant_summary(session, tenant)
    staff_rows = session.exec(
        select(models.User)
        .where(models.User.tenant_id == tenant_id)
        .order_by(models.User.role, models.User.email)  # type: ignore[arg-type]
    ).all()
    products = session.exec(select(models.Product).where(models.Product.tenant_id == tenant_id)).all()
    tables = session.exec(select(models.Table).where(models.Table.tenant_id == tenant_id)).all()
    assigned_plaques = session.exec(
        select(models.SmartPlaque).where(models.SmartPlaque.assigned_tenant_id == tenant_id)
    ).all()
    payment_ready = bool(
        tenant.stripe_publishable_key
        and tenant_stripe_secret(tenant)
        and tenant_stripe_webhook_secret(tenant)
    )
    checks = {
        "business_profile": bool(tenant.email and tenant.phone and tenant.address),
        "service_hours": bool(tenant.ordering_service_hours),
        "menu": bool(products),
        "menu_prices": bool(products) and all(product.price_cents > 0 for product in products),
        "allergens_reviewed": bool(products) and all(product.allergen_reviewed for product in products),
        "tables": bool(tables),
        "table_plan_limit": len(tables) <= tenant_table_limit(tenant),
        "plaques_assigned": bool(tables) and len(assigned_plaques) >= len(tables),
        "nfc_verified": bool(tables) and sum(1 for plaque in assigned_plaques if plaque.nfc_verified_at) >= len(tables),
        "kitchen_station": tenant.default_kitchen_station_id is not None,
        "kitchen_account": any(user.role == models.UserRole.kitchen for user in staff_rows),
        "stripe": payment_ready,
        "legal_urls": bool(tenant.public_terms_of_service_url and tenant.public_privacy_policy_url),
        "onboarding": tenant.onboarding_status == "completed",
    }
    launch_required = (
        "business_profile", "service_hours", "menu", "menu_prices", "allergens_reviewed",
        "tables", "table_plan_limit", "plaques_assigned", "nfc_verified", "kitchen_station",
        "kitchen_account", "stripe", "legal_urls", "onboarding",
    )
    readiness = {
        "ready": all(checks[name] for name in launch_required),
        "checks": checks,
        "missing": [name for name in launch_required if not checks[name]],
    }

    return models.PlatformTenantDetail(
        **summary.model_dump(),
        business_type=(
            tenant.business_type.value if tenant.business_type is not None else None
        ),
        description=tenant.description,
        address=tenant.address,
        website=tenant.website,
        staff_users=[
            models.PlatformStaffContact(
                email=u.email,
                full_name=u.full_name,
                role=u.role.value,
            )
            for u in staff_rows
        ],
        readiness=readiness,
    )


def _login_summary(
    session: Session, row: models.LoginEvent
) -> models.PlatformLoginSummary:
    user_email: str | None = None
    if row.user_id is not None:
        user = session.get(models.User, row.user_id)
        if user:
            user_email = user.email

    tenant_name: str | None = None
    if row.tenant_id is not None:
        tenant = session.get(models.Tenant, row.tenant_id)
        if tenant:
            tenant_name = tenant.name

    return models.PlatformLoginSummary(
        logged_in_at=row.logged_in_at,
        role=row.role.value if row.role else None,
        tenant_id=row.tenant_id,
        tenant_name=tenant_name,
        login_scope=row.login_scope,
        user_email=user_email,
    )


@router.get("/me")
def platform_me(
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
) -> dict:
    return {
        "id": current_user.id,
        "email": current_user.email,
        "full_name": current_user.full_name,
        "role": current_user.role.value,
    }


@router.get("/tenants", response_model=list[models.PlatformTenantSummary])
def platform_tenants(
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> list[models.PlatformTenantSummary]:
    tenants = session.exec(
        select(models.Tenant)
        .order_by(models.Tenant.created_at.desc())  # type: ignore[arg-type]
        .limit(_TENANT_LIST_LIMIT)
    ).all()
    return [_tenant_summary(session, t) for t in tenants if t.id is not None]


def _temporary_password() -> str:
    """Return a strong, one-time credential suitable for copying to the owner."""
    return f"Ot!{secrets.token_urlsafe(12)}"


@router.post(
    "/tenants",
    response_model=models.PlatformRestaurantCredentials,
    status_code=status.HTTP_201_CREATED,
)
async def platform_create_restaurant(
    body: models.PlatformRestaurantCreate,
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> models.PlatformRestaurantCredentials:
    """Provision a restaurant owner and return the one-time temporary credentials."""
    try:
        owner_email = normalize_email_address(body.owner_email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid owner email address") from exc

    restaurant_name = body.restaurant_name.strip()
    if len(restaurant_name) < 2:
        raise HTTPException(status_code=400, detail="Restaurant name is required")
    if session.exec(select(models.User).where(models.User.email == owner_email)).first():
        raise HTTPException(status_code=409, detail="That owner email already has an account")

    now = datetime.now(timezone.utc)
    temporary_password = _temporary_password()
    tenant = models.Tenant(
        name=restaurant_name,
        email=owner_email,
        currency_code="GBP",
        timezone="Europe/London",
        default_language="en",
        country_code="GB",
        ordering_mode="menu_only",
        ui_modules=new_tenant_ui_modules_stored(),
        saas_subscription_status=initial_status_for_new_tenant(),
        onboarding_status="not_started",
        onboarding_step=0,
        saas_plan_code=normalize_plan_code(body.plan_code),
    )
    session.add(tenant)
    session.flush()
    owner = models.User(
        email=owner_email,
        hashed_password=security.get_password_hash(temporary_password),
        full_name=(body.owner_name or "").strip() or None,
        role=models.UserRole.owner,
        tenant_id=tenant.id,
        must_change_password=True,
        temporary_password_issued_at=now,
    )
    session.add(owner)
    session.flush()

    password_setup_url: str | None = None
    base = (settings.public_app_base_url or "").strip().rstrip("/")
    if base:
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        expires_at = now + timedelta(minutes=settings.password_reset_token_expire_minutes)
        session.add(
            models.PasswordResetToken(
                user_id=owner.id,
                token_hash=token_hash,
                expires_at=expires_at,
            )
        )
        password_setup_url = f"{base}/reset-password?token={quote(raw_token, safe='')}"

    session.commit()
    session.refresh(tenant)
    invitation_email_sent = False
    if password_setup_url:
        invitation_email_sent = await send_restaurant_invitation_email(
            owner_email,
            tenant.name,
            password_setup_url,
        )
        tenant.invitation_sent_at = datetime.now(timezone.utc) if invitation_email_sent else None
        tenant.invitation_last_error = None if invitation_email_sent else "SMTP delivery failed or is not configured"
        session.add(tenant)
        session.commit()
        session.refresh(tenant)
    return models.PlatformRestaurantCredentials(
        tenant_id=tenant.id,
        restaurant_name=tenant.name,
        username=owner_email,
        temporary_password=temporary_password,
        password_setup_url=password_setup_url,
        plan_code=normalize_plan_code(tenant.saas_plan_code),
        table_limit=tenant_table_limit(tenant),
        invitation_email_sent=invitation_email_sent,
    )


@router.get("/tenants/{tenant_id}", response_model=models.PlatformTenantDetail)
def platform_tenant_detail(
    tenant_id: int,
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> models.PlatformTenantDetail:
    tenant = session.get(models.Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    return _tenant_detail(session, tenant)


@router.get("/subscriptions")
def platform_subscriptions(
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
    search: str = Query(default="", max_length=200),
    status_filter: str = Query(default="", alias="status", max_length=32),
    plan: str = Query(default="", max_length=16),
    health: str = Query(default="", max_length=32),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    return list_subscriptions(
        session,
        search=search,
        status_filter=status_filter,
        plan_filter=plan,
        health_filter=health,
        page=page,
        page_size=page_size,
    )


@router.get("/subscriptions/metrics")
def platform_subscription_metrics(
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> dict:
    return subscription_metrics(session)


@router.get("/tenants/{tenant_id}/billing-history")
def platform_tenant_billing_history(
    tenant_id: int,
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict:
    tenant = session.get(models.Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return billing_history(session, tenant, limit)


@router.post("/tenants/{tenant_id}/subscription/action", response_model=models.PlatformTenantDetail)
def platform_subscription_action(
    tenant_id: int,
    body: models.PlatformSubscriptionAction,
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> models.PlatformTenantDetail:
    tenant = session.get(models.Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    apply_admin_action(session, tenant, action=body.action, immediate=body.immediate)
    return _tenant_detail(session, tenant)


@router.put("/tenants/{tenant_id}/plan", response_model=models.PlatformTenantDetail)
def platform_update_tenant_plan(
    tenant_id: int,
    body: models.PlatformTenantPlanUpdate,
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> models.PlatformTenantDetail:
    tenant = session.get(models.Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if body.proration_behavior not in {"create_prorations", "always_invoice", "none"}:
        raise HTTPException(status_code=400, detail="Invalid proration behavior")
    sync_stripe_plan(
        session,
        tenant,
        plan_code=body.plan_code,
        extra_tables=body.extra_tables,
        proration_behavior=body.proration_behavior,
    )
    return _tenant_detail(session, tenant)


@router.get("/metrics", response_model=models.PlatformMetricsResponse)
def platform_metrics(
    current_user: Annotated[models.User, Depends(_require_platform_operator)],
    session: Session = Depends(get_session),
) -> models.PlatformMetricsResponse:
    now = datetime.now(timezone.utc)
    since_30d = now - timedelta(days=30)
    since_24h = now - timedelta(hours=24)
    since_7d = now - timedelta(days=7)

    tenant_count = session.exec(select(func.count()).select_from(models.Tenant)).one()
    signups_last_30_days = session.exec(
        select(func.count())
        .select_from(models.Tenant)
        .where(models.Tenant.created_at >= since_30d)
    ).one()

    recent_tenants = session.exec(
        select(models.Tenant)
        .order_by(models.Tenant.created_at.desc())  # type: ignore[arg-type]
        .limit(10)
    ).all()

    logins_total = session.exec(
        select(func.count()).select_from(models.LoginEvent)
    ).one()
    logins_last_24_hours = session.exec(
        select(func.count())
        .select_from(models.LoginEvent)
        .where(models.LoginEvent.logged_in_at >= since_24h)
    ).one()
    logins_last_7_days = session.exec(
        select(func.count())
        .select_from(models.LoginEvent)
        .where(models.LoginEvent.logged_in_at >= since_7d)
    ).one()

    recent_login_rows = session.exec(
        select(models.LoginEvent)
        .order_by(models.LoginEvent.logged_in_at.desc())  # type: ignore[arg-type]
        .limit(20)
    ).all()
    last_login_at = recent_login_rows[0].logged_in_at if recent_login_rows else None

    return models.PlatformMetricsResponse(
        tenant_count=int(tenant_count or 0),
        signups_last_30_days=int(signups_last_30_days or 0),
        logins_total=int(logins_total or 0),
        logins_last_24_hours=int(logins_last_24_hours or 0),
        logins_last_7_days=int(logins_last_7_days or 0),
        last_login_at=last_login_at,
        recent_tenants=[
            _tenant_summary(session, t) for t in recent_tenants if t.id is not None
        ],
        recent_logins=[_login_summary(session, row) for row in recent_login_rows],
    )
