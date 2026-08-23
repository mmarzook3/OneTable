"""Restaurant-owner first-login onboarding for platform-provisioned tenants."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func
from sqlmodel import Session, select

from . import models, security
from .contact_validation import normalize_email_address, normalize_phone_e164
from .db import get_session
from .onetable_ordering import DAY_NAMES
from .security import get_current_user
from .settings import settings
from .tenant_payment_credentials import tenant_stripe_secret


router = APIRouter()


def _require_owner(
    current_user: Annotated[models.User, Depends(get_current_user)],
) -> models.User:
    if current_user.role != models.UserRole.owner or current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Restaurant owner account required",
        )
    return current_user


def _count(session: Session, model: type, tenant_id: int) -> int:
    value = session.exec(
        select(func.count()).select_from(model).where(model.tenant_id == tenant_id)  # type: ignore[arg-type]
    ).one()
    return int(value or 0)


def _tenant_for_owner(session: Session, owner: models.User) -> models.Tenant:
    tenant = session.get(models.Tenant, owner.tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return tenant


def _advance(tenant: models.Tenant, step: int) -> None:
    tenant.onboarding_step = max(int(tenant.onboarding_step or 0), step)
    if tenant.onboarding_status != "completed":
        tenant.onboarding_status = "in_progress"
        tenant.onboarding_started_at = tenant.onboarding_started_at or datetime.now(timezone.utc)


def _state(
    session: Session,
    tenant: models.Tenant,
    owner: models.User,
) -> models.RestaurantOnboardingState:
    tenant_id = int(tenant.id)
    return models.RestaurantOnboardingState(
        status=tenant.onboarding_status,
        current_step=int(tenant.onboarding_step or 0),
        must_change_password=bool(owner.must_change_password),
        restaurant_name=tenant.name,
        business_type=tenant.business_type.value if tenant.business_type else None,
        owner_name=owner.full_name,
        owner_email=owner.email,
        business_email=tenant.email,
        phone=tenant.phone,
        address=tenant.address,
        currency_code=tenant.currency_code or "GBP",
        timezone=tenant.timezone or "Europe/London",
        ordering_mode=tenant.ordering_mode or "menu_only",
        ordering_service_hours=tenant.ordering_service_hours,
        floor_count=_count(session, models.Floor, tenant_id),
        table_count=_count(session, models.Table, tenant_id),
        product_count=_count(session, models.Product, tenant_id),
        payment_configured=bool(
            tenant.stripe_publishable_key and tenant_stripe_secret(tenant)
        ),
    )


@router.get("/status", response_model=models.RestaurantOnboardingState)
def onboarding_status(
    owner: Annotated[models.User, Depends(_require_owner)],
    session: Session = Depends(get_session),
) -> models.RestaurantOnboardingState:
    tenant = _tenant_for_owner(session, owner)
    if tenant.onboarding_status == "not_started":
        _advance(tenant, 0)
        session.add(tenant)
        session.commit()
        session.refresh(tenant)
    return _state(session, tenant, owner)


@router.put("/password", response_model=models.RestaurantOnboardingState)
def onboarding_password(
    body: models.RestaurantOnboardingPassword,
    owner: Annotated[models.User, Depends(_require_owner)],
    session: Session = Depends(get_session),
) -> models.RestaurantOnboardingState:
    tenant = _tenant_for_owner(session, owner)
    if owner.must_change_password:
        owner.hashed_password = security.get_password_hash(body.new_password)
        owner.must_change_password = False
        owner.temporary_password_issued_at = None
        session.exec(
            delete(models.PasswordResetToken).where(
                models.PasswordResetToken.user_id == owner.id,
                models.PasswordResetToken.used_at.is_(None),
            )
        )
        session.add(owner)
    _advance(tenant, 1)
    session.add(tenant)
    session.commit()
    session.refresh(owner)
    session.refresh(tenant)
    return _state(session, tenant, owner)


@router.put("/business", response_model=models.RestaurantOnboardingState)
def onboarding_business(
    body: models.RestaurantOnboardingBusiness,
    owner: Annotated[models.User, Depends(_require_owner)],
    session: Session = Depends(get_session),
) -> models.RestaurantOnboardingState:
    tenant = _tenant_for_owner(session, owner)
    business_email = None
    if body.business_email and body.business_email.strip():
        try:
            business_email = normalize_email_address(body.business_email)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid business email address") from exc
    phone = None
    if body.phone and body.phone.strip():
        try:
            phone = normalize_phone_e164(body.phone, settings.default_phone_country)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid phone number") from exc

    tenant.name = body.restaurant_name.strip()
    tenant.business_type = body.business_type
    tenant.email = business_email
    tenant.phone = phone
    tenant.address = (body.address or "").strip() or None
    owner.full_name = (body.owner_name or "").strip() or None
    _advance(tenant, 2)
    session.add(owner)
    session.add(tenant)
    session.commit()
    session.refresh(owner)
    session.refresh(tenant)
    return _state(session, tenant, owner)


@router.put("/operations", response_model=models.RestaurantOnboardingState)
def onboarding_operations(
    body: models.RestaurantOnboardingOperations,
    owner: Annotated[models.User, Depends(_require_owner)],
    session: Session = Depends(get_session),
) -> models.RestaurantOnboardingState:
    tenant = _tenant_for_owner(session, owner)
    requested_days = {day.strip().lower() for day in body.days_open}
    if not requested_days or requested_days - set(DAY_NAMES):
        raise HTTPException(status_code=400, detail="Select at least one valid opening day")
    try:
        opening = datetime.strptime(body.opening_time, "%H:%M").time()
        closing = datetime.strptime(body.closing_time, "%H:%M").time()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Opening times must use HH:MM") from exc
    if opening == closing:
        raise HTTPException(status_code=400, detail="Opening and closing times must differ")

    hours = {
        day: (
            {"open": body.opening_time, "close": body.closing_time, "closed": False}
            if day in requested_days
            else {"closed": True}
        )
        for day in DAY_NAMES
    }
    tenant.ordering_service_hours = hours
    tenant.opening_hours = json.dumps(hours)
    tenant.currency_code = "GBP"
    tenant.timezone = "Europe/London"
    tenant.default_language = "en"
    tenant.country_code = "GB"
    _advance(tenant, 3)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    return _state(session, tenant, owner)


@router.post("/tables", response_model=models.RestaurantOnboardingState)
def onboarding_tables(
    body: models.RestaurantOnboardingTables,
    owner: Annotated[models.User, Depends(_require_owner)],
    session: Session = Depends(get_session),
) -> models.RestaurantOnboardingState:
    tenant = _tenant_for_owner(session, owner)
    existing_tables = session.exec(
        select(models.Table).where(models.Table.tenant_id == tenant.id)
    ).all()
    if not existing_tables:
        floor = session.exec(
            select(models.Floor).where(models.Floor.tenant_id == tenant.id).limit(1)
        ).first()
        if floor is None:
            floor = models.Floor(
                tenant_id=int(tenant.id),
                name=body.floor_name.strip(),
                sort_order=1,
                seating_zone="indoor",
            )
            session.add(floor)
            session.flush()
        rows = [
            models.Table(
                tenant_id=int(tenant.id),
                floor_id=floor.id,
                name=f"{body.table_prefix}{number}".strip(),
                seat_count=body.seats_per_table,
            )
            for number in range(1, body.table_count + 1)
        ]
        session.add_all(rows)
    _advance(tenant, 4)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    return _state(session, tenant, owner)


@router.put("/progress", response_model=models.RestaurantOnboardingState)
def onboarding_progress(
    body: models.RestaurantOnboardingProgress,
    owner: Annotated[models.User, Depends(_require_owner)],
    session: Session = Depends(get_session),
) -> models.RestaurantOnboardingState:
    tenant = _tenant_for_owner(session, owner)
    _advance(tenant, body.current_step)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    return _state(session, tenant, owner)


@router.post("/complete", response_model=models.RestaurantOnboardingState)
def onboarding_complete(
    owner: Annotated[models.User, Depends(_require_owner)],
    session: Session = Depends(get_session),
) -> models.RestaurantOnboardingState:
    tenant = _tenant_for_owner(session, owner)
    if owner.must_change_password:
        raise HTTPException(status_code=409, detail="Choose a permanent password first")
    if not tenant.ordering_service_hours:
        raise HTTPException(status_code=409, detail="Set the restaurant opening hours first")
    if _count(session, models.Table, int(tenant.id)) < 1:
        raise HTTPException(status_code=409, detail="Create at least one table first")

    payment_ready = bool(tenant.stripe_publishable_key and tenant_stripe_secret(tenant))
    menu_ready = _count(session, models.Product, int(tenant.id)) > 0
    tenant.ordering_mode = "automatic" if payment_ready and menu_ready else "menu_only"
    tenant.immediate_payment_required = payment_ready
    tenant.onboarding_status = "completed"
    tenant.onboarding_step = 5
    tenant.onboarding_completed_at = datetime.now(timezone.utc)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    return _state(session, tenant, owner)
