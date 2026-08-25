"""Platform-operator subscription search, actions, Stripe history and reporting."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import stripe
from fastapi import HTTPException, status
from sqlalchemy import func, or_
from sqlmodel import Session, select

from . import models
from .saas_billing import (
    SAAS_STATUS_ACTIVE,
    SAAS_STATUS_CANCELED,
    SAAS_STATUS_GRANDFATHERED,
    SAAS_STATUS_PAST_DUE,
    SAAS_STATUS_SUSPENDED,
    SAAS_STATUS_TRIALING,
    apply_stripe_subscription_object,
    normalize_plan_code,
    plan_config,
    plan_details,
    record_subscription_event,
    stripe_customer_dashboard_url,
    stripe_extra_table_price_id_for_plan,
    stripe_price_id_for_plan,
    tenant_monthly_cents,
    tenant_table_limit,
)
from .settings import settings


VALID_ACTIONS = {"activate", "suspend", "cancel", "grandfather"}


def _dt(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _obj_get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _tenant_row(session: Session, tenant: models.Tenant) -> dict[str, Any]:
    table_count = int(
        session.exec(
            select(func.count()).select_from(models.Table).where(models.Table.tenant_id == tenant.id)
        ).one()
        or 0
    )
    status_value = (tenant.saas_subscription_status or "none").lower()
    monthly_cents = (
        tenant_monthly_cents(tenant, session)
        if status_value == SAAS_STATUS_ACTIVE
        else 0
    )
    return {
        "tenant_id": tenant.id,
        "tenant_name": tenant.name,
        "owner_email": next(
            (
                row.email
                for row in session.exec(
                    select(models.User).where(
                        models.User.tenant_id == tenant.id,
                        models.User.role == models.UserRole.owner,
                    )
                ).all()
            ),
            None,
        ),
        "status": status_value,
        "plan_code": normalize_plan_code(tenant.saas_plan_code),
        "extra_tables": max(0, int(tenant.saas_extra_tables or 0)),
        "table_count": table_count,
        "table_limit": tenant_table_limit(tenant),
        "monthly_cents": monthly_cents,
        "currency": plan_config(session)["currency"],
        "trial_ends_at": _dt(tenant.saas_trial_ends_at),
        "renewal_at": _dt(tenant.saas_subscription_ends_at),
        "cancel_at_period_end": bool(tenant.saas_cancel_at_period_end),
        "stripe_customer_id": tenant.saas_stripe_customer_id,
        "stripe_subscription_id": tenant.saas_stripe_subscription_id,
        "stripe_customer_url": stripe_customer_dashboard_url(tenant.saas_stripe_customer_id),
        "last_payment_at": _dt(tenant.saas_last_payment_at),
        "last_payment_failed_at": _dt(tenant.saas_last_payment_failed_at),
        "last_invoice_id": tenant.saas_last_invoice_id,
        "last_invoice_status": tenant.saas_last_invoice_status,
        "last_invoice_amount_cents": tenant.saas_last_invoice_amount_cents,
        "last_invoice_currency": tenant.saas_last_invoice_currency,
        "created_at": tenant.created_at.isoformat(),
    }


def list_subscriptions(
    session: Session,
    *,
    search: str = "",
    status_filter: str = "",
    plan_filter: str = "",
    health_filter: str = "",
    page: int = 1,
    page_size: int = 25,
) -> dict[str, Any]:
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    filters = []
    if search.strip():
        value = f"%{search.strip()}%"
        filters.append(
            or_(
                models.Tenant.name.ilike(value),
                models.Tenant.email.ilike(value),
                models.Tenant.saas_stripe_customer_id.ilike(value),
                models.Tenant.saas_stripe_subscription_id.ilike(value),
            )
        )
    if status_filter.strip():
        filters.append(models.Tenant.saas_subscription_status == status_filter.strip().lower())
    if plan_filter.strip():
        filters.append(models.Tenant.saas_plan_code == normalize_plan_code(plan_filter))
    if health_filter == "overdue":
        filters.append(models.Tenant.saas_subscription_status == SAAS_STATUS_PAST_DUE)
    elif health_filter == "failed":
        filters.append(models.Tenant.saas_last_payment_failed_at.is_not(None))
    elif health_filter == "canceling":
        filters.append(models.Tenant.saas_cancel_at_period_end == True)

    count_query = select(func.count()).select_from(models.Tenant)
    rows_query = select(models.Tenant)
    for condition in filters:
        count_query = count_query.where(condition)
        rows_query = rows_query.where(condition)
    total = int(session.exec(count_query).one() or 0)
    rows = session.exec(
        rows_query.order_by(models.Tenant.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return {
        "items": [_tenant_row(session, tenant) for tenant in rows],
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


def subscription_metrics(session: Session) -> dict[str, Any]:
    tenants = session.exec(select(models.Tenant)).all()
    status_counts: dict[str, int] = {}
    mrr_cents = 0
    for tenant in tenants:
        current = (tenant.saas_subscription_status or "none").lower()
        status_counts[current] = status_counts.get(current, 0) + 1
        if current == SAAS_STATUS_ACTIVE:
            mrr_cents += tenant_monthly_cents(tenant, session)

    since_30d = datetime.now(timezone.utc) - timedelta(days=30)
    churned_30d = int(
        session.exec(
            select(func.count(func.distinct(models.SaasSubscriptionEvent.tenant_id))).where(
                models.SaasSubscriptionEvent.created_at >= since_30d,
                models.SaasSubscriptionEvent.new_status == SAAS_STATUS_CANCELED,
            )
        ).one()
        or 0
    )
    revenue_total = int(
        session.exec(
            select(func.coalesce(func.sum(models.SaasSubscriptionEvent.amount_cents), 0)).where(
                models.SaasSubscriptionEvent.event_type == "invoice_paid"
            )
        ).one()
        or 0
    )
    revenue_30d = int(
        session.exec(
            select(func.coalesce(func.sum(models.SaasSubscriptionEvent.amount_cents), 0)).where(
                models.SaasSubscriptionEvent.event_type == "invoice_paid",
                models.SaasSubscriptionEvent.created_at >= since_30d,
            )
        ).one()
        or 0
    )
    active = status_counts.get(SAAS_STATUS_ACTIVE, 0)
    denominator = active + churned_30d
    return {
        "mrr_cents": mrr_cents,
        "revenue_total_cents": revenue_total,
        "revenue_30d_cents": revenue_30d,
        "currency": plan_config(session)["currency"],
        "active_count": active,
        "trialing_count": status_counts.get(SAAS_STATUS_TRIALING, 0),
        "past_due_count": status_counts.get(SAAS_STATUS_PAST_DUE, 0),
        "suspended_count": status_counts.get(SAAS_STATUS_SUSPENDED, 0),
        "canceling_count": sum(1 for tenant in tenants if tenant.saas_cancel_at_period_end),
        "churned_30d": churned_30d,
        "churn_rate_30d": round(churned_30d / denominator * 100, 2) if denominator else 0.0,
        "status_counts": status_counts,
    }


def _stripe_secret() -> str:
    secret = (settings.stripe_secret_key or "").strip()
    if not secret:
        raise HTTPException(status_code=409, detail="Platform Stripe is not configured")
    return secret


def sync_stripe_plan(
    session: Session,
    tenant: models.Tenant,
    *,
    plan_code: str,
    extra_tables: int,
    proration_behavior: str = "create_prorations",
) -> models.Tenant:
    plan_code = normalize_plan_code(plan_code)
    extra_tables = max(0, int(extra_tables))
    old_plan = normalize_plan_code(tenant.saas_plan_code)
    old_extra = int(tenant.saas_extra_tables or 0)
    if tenant.saas_stripe_subscription_id:
        secret = _stripe_secret()
        base_price = stripe_price_id_for_plan(plan_code, session)
        if not base_price:
            raise HTTPException(status_code=409, detail=f"Stripe Price is missing for {plan_code}")
        extra_price = stripe_extra_table_price_id_for_plan(plan_code, session)
        known_extra_prices = {
            str(value)
            for value in session.exec(
                select(models.SaasPlanPricing.stripe_extra_table_price_id).where(
                    models.SaasPlanPricing.stripe_extra_table_price_id.is_not(None)
                )
            ).all()
            if value
        }
        known_extra_prices.add(extra_price)
        if extra_tables and not extra_price:
            raise HTTPException(status_code=409, detail="Stripe extra-table Price is missing")
        try:
            subscription = stripe.Subscription.retrieve(
                tenant.saas_stripe_subscription_id,
                api_key=secret,
                expand=["items.data.price"],
            )
            items = list(_obj_get(_obj_get(subscription, "items"), "data", []) or [])
            updates: list[dict[str, Any]] = []
            extra_items: list[Any] = []
            base_item = None
            for item in items:
                price = _obj_get(item, "price")
                price_id = str(_obj_get(price, "id") or price or "")
                if price_id in known_extra_prices:
                    extra_items.append(item)
                else:
                    base_item = base_item or item
            if not base_item:
                raise HTTPException(status_code=409, detail="Stripe base subscription item was not found")
            updates.append({"id": _obj_get(base_item, "id"), "price": base_price, "quantity": 1})
            if extra_tables:
                if extra_items:
                    updates.append({"id": _obj_get(extra_items[0], "id"), "price": extra_price, "quantity": extra_tables})
                else:
                    updates.append({"price": extra_price, "quantity": extra_tables})
            for duplicate in extra_items[1:] if extra_tables else extra_items:
                updates.append({"id": _obj_get(duplicate, "id"), "deleted": True})
            updated = stripe.Subscription.modify(
                tenant.saas_stripe_subscription_id,
                items=updates,
                proration_behavior=proration_behavior,
                payment_behavior="pending_if_incomplete",
                metadata={"tenant_id": str(tenant.id), "plan_code": plan_code},
                api_key=secret,
            )
            apply_stripe_subscription_object(session, tenant, updated, commit=False)
        except stripe.error.StripeError as exc:
            raise HTTPException(status_code=502, detail=str(exc.user_message or exc)) from exc
    tenant.saas_plan_code = plan_code
    tenant.saas_extra_tables = extra_tables
    selected = plan_details(plan_code, session)
    tenant.saas_monthly_price_cents = int(selected["price_cents"])
    tenant.saas_extra_table_unit_price_cents = int(selected["extra_table_price_cents"])
    tenant.saas_included_tables = int(selected["included_tables"])
    session.add(tenant)
    record_subscription_event(
        session,
        tenant,
        "plan_changed",
        source="platform",
        detail={"old_plan": old_plan, "new_plan": plan_code, "old_extra_tables": old_extra, "new_extra_tables": extra_tables, "proration_behavior": proration_behavior},
    )
    session.commit()
    session.refresh(tenant)
    return tenant


def apply_admin_action(
    session: Session,
    tenant: models.Tenant,
    *,
    action: str,
    immediate: bool = False,
) -> models.Tenant:
    action = action.strip().lower()
    if action not in VALID_ACTIONS:
        raise HTTPException(status_code=400, detail="Invalid subscription action")
    old_status = tenant.saas_subscription_status
    secret = (settings.stripe_secret_key or "").strip()
    sub_id = tenant.saas_stripe_subscription_id
    try:
        if action == "cancel" and sub_id and secret:
            if immediate:
                cancel_method = getattr(stripe.Subscription, "cancel", None) or getattr(stripe.Subscription, "delete")
                cancel_method(sub_id, api_key=secret)
                tenant.saas_subscription_status = SAAS_STATUS_CANCELED
                tenant.saas_cancel_at_period_end = False
                tenant.saas_subscription_ends_at = datetime.now(timezone.utc)
            else:
                updated = stripe.Subscription.modify(sub_id, cancel_at_period_end=True, api_key=secret)
                tenant.saas_cancel_at_period_end = True
                period_end = _obj_get(updated, "current_period_end")
                if period_end:
                    tenant.saas_subscription_ends_at = datetime.fromtimestamp(int(period_end), tz=timezone.utc)
        elif action == "suspend":
            if sub_id and secret:
                stripe.Subscription.modify(sub_id, pause_collection={"behavior": "void"}, api_key=secret)
            tenant.saas_subscription_status = SAAS_STATUS_SUSPENDED
            tenant.saas_suspended_at = datetime.now(timezone.utc)
        elif action == "activate":
            if sub_id and secret:
                stripe.Subscription.modify(sub_id, pause_collection="", cancel_at_period_end=False, api_key=secret)
            tenant.saas_subscription_status = SAAS_STATUS_ACTIVE
            tenant.saas_suspended_at = None
            tenant.saas_cancel_at_period_end = False
        elif action == "grandfather":
            if sub_id and secret:
                stripe.Subscription.modify(sub_id, cancel_at_period_end=True, api_key=secret)
                tenant.saas_cancel_at_period_end = True
            tenant.saas_subscription_status = SAAS_STATUS_GRANDFATHERED
            tenant.saas_suspended_at = None
        elif action == "cancel":
            tenant.saas_subscription_status = SAAS_STATUS_CANCELED
            tenant.saas_cancel_at_period_end = False
            tenant.saas_subscription_ends_at = datetime.now(timezone.utc)
    except stripe.error.StripeError as exc:
        raise HTTPException(status_code=502, detail=str(exc.user_message or exc)) from exc
    session.add(tenant)
    record_subscription_event(
        session,
        tenant,
        f"admin_{action}",
        source="platform",
        old_status=old_status,
        new_status=tenant.saas_subscription_status,
        detail={"immediate": immediate, "cancel_at_period_end": tenant.saas_cancel_at_period_end},
    )
    session.commit()
    session.refresh(tenant)
    return tenant


def billing_history(session: Session, tenant: models.Tenant, limit: int = 50) -> dict[str, Any]:
    events = session.exec(
        select(models.SaasSubscriptionEvent)
        .where(models.SaasSubscriptionEvent.tenant_id == tenant.id)
        .order_by(models.SaasSubscriptionEvent.created_at.desc())
        .limit(max(1, min(limit, 100)))
    ).all()
    result: dict[str, Any] = {
        "stripe_configured": bool(settings.stripe_secret_key and tenant.saas_stripe_customer_id),
        "stripe_customer_url": stripe_customer_dashboard_url(tenant.saas_stripe_customer_id),
        "invoices": [],
        "payments": [],
        "events": [row.model_dump(mode="json") for row in events],
        "stripe_error": None,
    }
    if not result["stripe_configured"]:
        return result
    try:
        invoices = stripe.Invoice.list(customer=tenant.saas_stripe_customer_id, limit=limit, api_key=_stripe_secret())
        for invoice in list(_obj_get(invoices, "data", []) or []):
            result["invoices"].append({
                "id": _obj_get(invoice, "id"),
                "number": _obj_get(invoice, "number"),
                "status": _obj_get(invoice, "status"),
                "amount_due": int(_obj_get(invoice, "amount_due", 0) or 0),
                "amount_paid": int(_obj_get(invoice, "amount_paid", 0) or 0),
                "currency": _obj_get(invoice, "currency"),
                "created_at": _dt(_obj_get(invoice, "created")),
                "due_at": _dt(_obj_get(invoice, "due_date")),
                "hosted_invoice_url": _obj_get(invoice, "hosted_invoice_url"),
                "invoice_pdf": _obj_get(invoice, "invoice_pdf"),
                "attempt_count": int(_obj_get(invoice, "attempt_count", 0) or 0),
            })
        payments = stripe.PaymentIntent.list(customer=tenant.saas_stripe_customer_id, limit=limit, api_key=_stripe_secret())
        for payment in list(_obj_get(payments, "data", []) or []):
            result["payments"].append({
                "id": _obj_get(payment, "id"),
                "status": _obj_get(payment, "status"),
                "amount": int(_obj_get(payment, "amount", 0) or 0),
                "amount_received": int(_obj_get(payment, "amount_received", 0) or 0),
                "currency": _obj_get(payment, "currency"),
                "created_at": _dt(_obj_get(payment, "created")),
            })
    except stripe.error.StripeError as exc:
        result["stripe_error"] = str(exc.user_message or exc)
    return result
