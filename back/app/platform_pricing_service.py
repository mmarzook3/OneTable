"""Platform-managed Scanaki tier pricing, offers, Stripe prices and migrations."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import stripe
from fastapi import HTTPException
from sqlmodel import Session, select

from . import models
from .saas_billing import (
    SAAS_PLAN_TABLES,
    normalize_plan_code,
    plan_details,
)
from .settings import settings


MIGRATION_MODES = {"new_customers_only", "next_renewal", "immediate"}


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _offer_active(row: models.SaasPlanPricing, now: datetime | None = None) -> bool:
    if row.offer_price_cents is None:
        return False
    current = now or datetime.now(timezone.utc)
    starts = _aware(row.offer_starts_at)
    ends = _aware(row.offer_ends_at)
    return (starts is None or starts <= current) and (ends is None or current < ends)


def _row_payload(row: models.SaasPlanPricing) -> dict[str, Any]:
    active_offer = _offer_active(row)
    return {
        **row.model_dump(mode="json"),
        "ordering_points_unlimited": row.plan_code == "pilot",
        "offer_active": active_offer,
        "effective_price_cents": (
            row.offer_price_cents if active_offer else row.regular_price_cents
        ),
    }


def _active_rows(session: Session) -> list[models.SaasPlanPricing]:
    return list(
        session.exec(
            select(models.SaasPlanPricing)
            .where(models.SaasPlanPricing.is_active == True)
            .order_by(models.SaasPlanPricing.plan_code)
        ).all()
    )


def pricing_console(session: Session) -> dict[str, Any]:
    rows = _active_rows(session)
    current_by_code = {row.plan_code: _row_payload(row) for row in rows}
    # Metadata-created test databases can have no migration seed; still expose editable defaults.
    for code in SAAS_PLAN_TABLES:
        if code not in current_by_code:
            fallback = plan_details(code, None)
            current_by_code[code] = {
                **fallback,
                "plan_code": code,
                "effective_price_cents": fallback["price_cents"],
                "is_active": True,
                "stripe_configured": False,
            }
    events = session.exec(
        select(models.SaasPricingEvent)
        .order_by(models.SaasPricingEvent.created_at.desc())
        .limit(50)
    ).all()
    return {
        "currency": "gbp",
        "stripe_configured": bool((settings.stripe_secret_key or "").strip()),
        "plans": [current_by_code[code] for code in SAAS_PLAN_TABLES],
        "events": [event.model_dump(mode="json") for event in events],
    }


def _validate_price_id(value: str | None, field: str) -> str | None:
    cleaned = (value or "").strip() or None
    if cleaned and not cleaned.startswith("price_"):
        raise HTTPException(status_code=400, detail=f"{field} must be a Stripe price_ identifier")
    return cleaned


def _validate_product_id(value: str | None) -> str | None:
    cleaned = (value or "").strip() or None
    if cleaned and not cleaned.startswith("prod_"):
        raise HTTPException(status_code=400, detail="Stripe product must be a prod_ identifier")
    return cleaned


def _stripe_price(
    *,
    product_id: str,
    amount_cents: int,
    currency: str,
    plan_code: str,
    purpose: str,
) -> str:
    created = stripe.Price.create(
        product=product_id,
        unit_amount=amount_cents,
        currency=currency,
        recurring={"interval": "month"},
        nickname=f"Scanaki {plan_code.title()} {purpose}",
        metadata={"scanaki_plan_code": plan_code, "scanaki_price_purpose": purpose},
        api_key=(settings.stripe_secret_key or "").strip(),
    )
    return str(getattr(created, "id", None) or created.get("id"))


def _prepare_stripe_ids(
    current: models.SaasPlanPricing | None,
    body: models.PlatformPricingPublish,
    plan_code: str,
) -> dict[str, str | None]:
    product_id = _validate_product_id(body.stripe_product_id or (current.stripe_product_id if current else None))
    regular_id = _validate_price_id(
        body.stripe_regular_price_id or (current.stripe_regular_price_id if current else None),
        "Regular Stripe price",
    )
    offer_id = _validate_price_id(
        body.stripe_offer_price_id or (current.stripe_offer_price_id if current else None),
        "Offer Stripe price",
    )
    extra_id = _validate_price_id(
        body.stripe_extra_table_price_id
        or (current.stripe_extra_table_price_id if current else None),
        "Extra-table Stripe price",
    )

    regular_changed = current is None or current.regular_price_cents != body.regular_price_cents
    offer_changed = current is None or current.offer_price_cents != body.offer_price_cents
    extra_changed = current is None or current.extra_table_price_cents != body.extra_table_price_cents
    if current and regular_changed and regular_id == current.stripe_regular_price_id:
        regular_id = None
    if body.offer_price_cents is None:
        offer_id = None
    elif current and offer_changed and offer_id == current.stripe_offer_price_id:
        offer_id = None
    if current and extra_changed and extra_id == current.stripe_extra_table_price_id:
        extra_id = None

    if body.create_stripe_prices:
        secret = (settings.stripe_secret_key or "").strip()
        if not secret:
            raise HTTPException(status_code=409, detail="Platform Stripe is not configured")
        try:
            if not product_id:
                product = stripe.Product.create(
                    name=f"Scanaki {body.name.strip()}",
                    metadata={"scanaki_plan_code": plan_code},
                    api_key=secret,
                )
                product_id = str(getattr(product, "id", None) or product.get("id"))
            if regular_changed or not regular_id:
                regular_id = _stripe_price(
                    product_id=product_id,
                    amount_cents=body.regular_price_cents,
                    currency=body.currency.lower(),
                    plan_code=plan_code,
                    purpose="regular",
                )
            if body.offer_price_cents is not None and (offer_changed or not offer_id):
                offer_id = _stripe_price(
                    product_id=product_id,
                    amount_cents=body.offer_price_cents,
                    currency=body.currency.lower(),
                    plan_code=plan_code,
                    purpose="offer",
                )
            if extra_changed or not extra_id:
                extra_id = _stripe_price(
                    product_id=product_id,
                    amount_cents=body.extra_table_price_cents,
                    currency=body.currency.lower(),
                    plan_code=plan_code,
                    purpose="extra-table",
                )
        except stripe.error.StripeError as exc:
            raise HTTPException(status_code=502, detail=str(exc.user_message or exc)) from exc
    return {
        "product": product_id,
        "regular": regular_id,
        "offer": offer_id,
        "extra": extra_id,
    }


def publish_pricing(
    session: Session,
    plan_code: str,
    body: models.PlatformPricingPublish,
    operator: models.User,
) -> dict[str, Any]:
    code = normalize_plan_code(plan_code)
    if code == "pilot":
        if body.is_public:
            raise HTTPException(
                status_code=400,
                detail="The internal Pilot tier cannot be published on the website",
            )
        if body.create_stripe_prices or any(
            (
                body.stripe_product_id,
                body.stripe_regular_price_id,
                body.stripe_offer_price_id,
                body.stripe_extra_table_price_id,
            )
        ):
            raise HTTPException(
                status_code=400,
                detail="The internal Pilot tier cannot use public Stripe prices",
            )
    mode = body.migration_mode.strip().lower()
    if mode not in MIGRATION_MODES:
        raise HTTPException(status_code=400, detail="Invalid existing-customer migration mode")
    currency = body.currency.strip().lower()
    if currency != "gbp":
        raise HTTPException(status_code=400, detail="Scanaki pricing currently supports GBP only")
    if body.offer_price_cents is not None and body.offer_price_cents >= body.regular_price_cents:
        raise HTTPException(status_code=400, detail="Offer price must be lower than the regular price")
    starts = _aware(body.offer_starts_at)
    ends = _aware(body.offer_ends_at)
    if starts and ends and ends <= starts:
        raise HTTPException(status_code=400, detail="Offer end must be after its start")

    current = session.exec(
        select(models.SaasPlanPricing).where(
            models.SaasPlanPricing.plan_code == code,
            models.SaasPlanPricing.is_active == True,
        )
    ).first()
    old = plan_details(code, session)
    stripe_ids = _prepare_stripe_ids(current, body, code)

    # Freeze old contracts before changing the public catalogue.
    tenants = list(session.exec(select(models.Tenant).where(models.Tenant.saas_plan_code == code)).all())
    for tenant in tenants:
        if tenant.saas_monthly_price_cents is None:
            tenant.saas_monthly_price_cents = int(old["price_cents"])
        if tenant.saas_extra_table_unit_price_cents is None:
            tenant.saas_extra_table_unit_price_cents = int(old["extra_table_price_cents"])
        if tenant.saas_included_tables is None:
            tenant.saas_included_tables = int(old["included_tables"])
        session.add(tenant)

    if current:
        current.is_active = False
        current.updated_at = datetime.now(timezone.utc)
        session.add(current)
        session.flush()
    latest = session.exec(
        select(models.SaasPlanPricing)
        .where(models.SaasPlanPricing.plan_code == code)
        .order_by(models.SaasPlanPricing.version.desc())
        .limit(1)
    ).first()
    revision = models.SaasPlanPricing(
        plan_code=code,
        version=(latest.version + 1) if latest else 1,
        name=body.name.strip(),
        description=(body.description or "").strip() or None,
        regular_price_cents=body.regular_price_cents,
        offer_price_cents=body.offer_price_cents,
        currency=currency,
        billing_interval="month",
        included_tables=body.included_tables,
        extra_table_price_cents=body.extra_table_price_cents,
        trial_days=body.trial_days,
        offer_badge=(body.offer_badge or "").strip() or None,
        offer_starts_at=starts,
        offer_ends_at=ends,
        is_featured=body.is_featured,
        is_public=body.is_public,
        stripe_product_id=stripe_ids["product"],
        stripe_regular_price_id=stripe_ids["regular"],
        stripe_offer_price_id=stripe_ids["offer"],
        stripe_extra_table_price_id=stripe_ids["extra"],
        is_active=True,
        created_by_user_id=operator.id,
    )
    session.add(revision)
    session.commit()
    session.refresh(revision)

    migrated = 0
    failures: list[dict[str, Any]] = []
    if mode != "new_customers_only":
        from .platform_subscription_service import sync_stripe_plan

        proration = "none" if mode == "next_renewal" else "always_invoice"
        for tenant in tenants:
            try:
                sync_stripe_plan(
                    session,
                    tenant,
                    plan_code=code,
                    extra_tables=int(tenant.saas_extra_tables or 0),
                    proration_behavior=proration,
                )
                migrated += 1
            except HTTPException as exc:
                session.rollback()
                failures.append({"tenant_id": tenant.id, "name": tenant.name, "detail": exc.detail})

    event = models.SaasPricingEvent(
        pricing_id=revision.id,
        plan_code=code,
        action="published",
        migration_mode=mode,
        migrated_count=migrated,
        failed_count=len(failures),
        created_by_user_id=operator.id,
        detail={
            "old_version": current.version if current else None,
            "new_version": revision.version,
            "old_effective_price_cents": old["price_cents"],
            "new_effective_price_cents": _row_payload(revision)["effective_price_cents"],
            "failures": failures[:50],
        },
    )
    session.add(event)
    session.commit()
    return {
        **pricing_console(session),
        "publication": {
            "plan_code": code,
            "version": revision.version,
            "migration_mode": mode,
            "migrated_count": migrated,
            "failed_count": len(failures),
            "failures": failures,
        },
    }
