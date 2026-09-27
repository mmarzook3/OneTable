"""Session-owned Stripe line payments; completed money uses the existing ledger."""
from datetime import datetime, timezone, timedelta
import hashlib
import json

from fastapi import HTTPException
from sqlmodel import Session, select
import stripe

from . import models, order_payment_service as payments
from .order_discounts import order_level_discount_cents

RESERVED = {"creating", "pending", "processing", "requires_staff_reconciliation"}
REFUNDED = {"refunded", "partially_refunded", "requires_staff_reconciliation"}


def field(value: object, name: str, default=None):
    """Support decoded JSON and Stripe's attribute-based SDK objects."""
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def account_binding(options: dict) -> str:
    # Bind both direct-account credentials and Connect destination without storing a key.
    identity = json.dumps({"account": options.get("stripe_account"),
                           "credential": options.get("api_key")}, sort_keys=True)
    return "stripe:" + hashlib.sha256(identity.encode()).hexdigest()


def session_hash(sid: str | None) -> str:
    value = (sid or "").strip()
    if not value or len(value) > 128:
        raise HTTPException(403, "session_id is required for customer checkout")
    return hashlib.sha256(value.encode()).hexdigest()


def lock_order(session: Session, order_id: int) -> models.Order:
    order = session.exec(select(models.Order).where(models.Order.id == order_id)
                         .with_for_update().execution_options(populate_existing=True)).first()
    if not order or order.deleted_at is not None:
        raise HTTPException(404, "Order not found")
    return order


def attempts(session: Session, order: models.Order):
    return session.exec(select(models.GuestPaymentAttempt).where(
        models.GuestPaymentAttempt.order_id == order.id,
        models.GuestPaymentAttempt.tenant_id == order.tenant_id,
    )).all()


def assert_no_pending(session: Session, order: models.Order):
    lock_order(session, order.id)
    if any(a.state in RESERVED for a in attempts(session, order)):
        raise HTTPException(409, "Customer checkout is pending; cancel it with the payment provider first")


def assert_no_captured(session: Session, order: models.Order):
    assert_no_pending(session, order)
    if any(a.state == "succeeded" or a.state in REFUNDED or a.refunded_amount_cents
           for a in attempts(session, order)):
        raise HTTPException(409, "Captured customer payments require refund reconciliation; they cannot be erased")


def assert_staff_item_mutation(session: Session, order: models.Order, item_id: int):
    assert_no_pending(session, order)
    if order.paid_at or item_id in payments.allocated_order_item_ids(session, order.id):
        raise HTTPException(409, "Paid items require refund reconciliation before they can be changed")


def assert_whole_provider_checkout(session: Session, order: models.Order):
    assert_no_captured(session, order)
    if payments.amount_paid_cents(session, order.id) > 0:
        raise HTTPException(409, "A partial payment exists; use staff settlement of the remaining balance")


def owned_items(session: Session, order: models.Order, sid: str):
    session_hash(sid)
    return [i for i in payments.active_order_items(session, order.id)
            if i.added_by_session == sid.strip()
            or (i.added_by_session is None and order.session_id == sid.strip())]


def validate_table(order: models.Order, table: models.Table):
    version = int(table.assignment_version or 1)
    snapshot = order.ordering_point_assignment_version_snapshot
    if (order.tenant_id != table.tenant_id or order.table_id != table.id
            or (snapshot != version and not (snapshot is None and version == 1))):
        raise HTTPException(404, "Order not found")


def uses_split(session: Session, order: models.Order, sid: str | None) -> bool:
    # Existing automatic, single-owner checkouts keep their original path.
    own = owned_items(session, order, sid or "")
    if not own:
        raise HTTPException(403, "No payable items belong to this session")
    return (order.session_id is None
            or len(own) != len(payments.active_order_items(session, order.id))
            or bool(attempts(session, order))
            or bool(payments.list_active_payments(session, order.id)))


def block_reason(session: Session, order: models.Order) -> str | None:
    if order.requires_prepayment:
        return "shared_prepayment_requires_staff"
    if order.status == models.OrderStatus.cancelled or order.payment_state in REFUNDED:
        return "requires_staff_reconciliation"
    if order.stripe_payment_intent_id or order.revolut_order_id or order.checkout_locked_at:
        return "existing_whole_bill_checkout"
    if order_level_discount_cents(order) or order.tip_amount_cents:
        return "discount_or_tip_requires_staff"
    for payment in payments.list_active_payments(session, order.id):
        if not payments.payment_line_ids(session, payment.id):
            return "unallocated_payment_requires_staff"
    if any(a.state in REFUNDED for a in attempts(session, order)):
        return "requires_staff_reconciliation"
    return None


def tracking(session: Session, order: models.Order, sid: str, items: list):
    allocated = payments.allocated_order_item_ids(session, order.id)
    full_paid = order.paid_at is not None
    line_fields = {}
    remaining = 0
    for item in items:
        payable = (not item.removed_by_customer and item.removed_by_user_id is None
                   and item.status != models.OrderItemStatus.cancelled)
        paid = item.id in allocated or full_paid
        cents = item.price_cents * item.quantity
        line_fields[item.id] = {"paid_cents": cents if paid else 0, "is_paid": paid}
        if payable and not paid:
            remaining += cents
    own_attempts = [a for a in attempts(session, order) if a.session_hash == session_hash(sid)]
    refunded = any(a.state in REFUNDED for a in own_attempts)
    active = payments.active_order_items(session, order.id)
    own_ids = {i.id for i in items}
    shared = any(i.id not in own_ids for i in active)
    existing_payments = payments.list_active_payments(session, order.id)
    scoped = shared or order.session_id is None or bool(own_attempts) or bool(existing_payments)
    reason = block_reason(session, order) if scoped and not full_paid else None
    if not scoped and not full_paid:
        remaining = payments.order_due_cents(session, order)
    refunded_cents = sum(a.refunded_amount_cents for a in own_attempts)
    state = "refunded" if refunded_cents else "requires_staff_reconciliation" if refunded else (
        "paid" if not remaining else "pending" if any(a.state in RESERVED for a in own_attempts) else "unpaid")
    return line_fields, {
        "amount_remaining_cents": remaining,
        "customer_payment_state": state,
        "customer_refunded_cents": refunded_cents,
        "can_pay": bool(remaining and not reason and not refunded),
        "payment_block_reason": reason,
        "shared_bill": shared,
        "can_cancel_order": bool(active and not shared and not full_paid and not allocated
                                 and not order.checkout_locked_at
                                 and not any(a.state in RESERVED for a in attempts(session, order))
                                 and all(i.status == models.OrderItemStatus.pending for i in active)),
    }


def assert_customer_mutation(session: Session, order: models.Order, table: models.Table,
                             sid: str | None, item_id: int | None = None):
    order = lock_order(session, order.id)
    validate_table(order, table)
    own = {i.id for i in owned_items(session, order, sid or "")}
    active = {i.id for i in payments.active_order_items(session, order.id)}
    if not own or (item_id is not None and item_id not in own) or (item_id is None and own != active):
        raise HTTPException(403, "Only your own items may be changed")
    assert_no_pending(session, order)
    allocated = payments.allocated_order_item_ids(session, order.id)
    if order.paid_at or (item_id in allocated if item_id is not None else bool(allocated)):
        raise HTTPException(409, "Paid items cannot be changed")


def create(session: Session, order: models.Order, table: models.Table, sid: str,
           currency: str, options: dict) -> dict:
    order = lock_order(session, order.id)
    validate_table(order, table)
    digest = session_hash(sid)
    reason = block_reason(session, order)
    if reason:
        raise HTTPException(409, reason)
    own = owned_items(session, order, sid)
    if not own:
        raise HTTPException(403, "No payable items belong to this session")
    allocated = payments.allocated_order_item_ids(session, order.id)
    unpaid = [i for i in own if i.id not in allocated]
    if order.paid_at or not unpaid:
        return {"status": "paid", "amount": 0, "order_fully_paid": bool(order.paid_at)}
    rows = attempts(session, order)
    active = next((a for a in rows if a.session_hash == digest and a.state in RESERVED), None)
    binding = account_binding(options)
    if active is None:
        wanted = {i.id for i in unpaid}
        if any(wanted.intersection(a.item_ids) for a in rows if a.state in RESERVED):
            raise HTTPException(409, "Items are reserved for another checkout")
        amount = sum(i.price_cents * i.quantity for i in unpaid)
        if amount <= 0:
            raise HTTPException(400, "No payable balance")
        active = models.GuestPaymentAttempt(
            tenant_id=order.tenant_id, order_id=order.id, session_hash=digest,
            item_ids=sorted(wanted), amount_cents=amount, currency=currency,
            account_binding=binding,
        )
        session.add(active)
        session.flush()
    if active.account_binding != binding or active.currency != currency:
        raise HTTPException(409, "Payment account changed; staff reconciliation required")
    # Stripe can discard idempotency keys after 24h. Never recreate an uncertain old charge.
    if not active.stripe_payment_intent_id and active.created_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc) - timedelta(hours=23):
        raise HTTPException(409, "Uncertain checkout requires staff reconciliation")
    attempt_id = active.id
    intent_id = active.stripe_payment_intent_id
    amount = active.amount_cents
    metadata = {"guest_payment_attempt_id": attempt_id, "order_id": str(order.id),
                "tenant_id": str(order.tenant_id), "payment_account_snapshot": binding}
    session.commit()  # Durable idempotency key before network; no row lock across Stripe.
    intent = (stripe.PaymentIntent.retrieve(intent_id, **options) if intent_id else
              stripe.PaymentIntent.create(amount=amount, currency=currency, metadata=metadata,
                                          idempotency_key=f"guest-lines-{attempt_id}", **options))
    lock_order(session, order.id)
    active = session.get(models.GuestPaymentAttempt, attempt_id, populate_existing=True)
    returned_id = field(intent, "id")
    if not isinstance(returned_id, str) or not returned_id:
        raise HTTPException(502, "Payment provider returned an invalid checkout")
    bound = lookup(session, intent, order.tenant_id)
    if bound is None or bound.id != attempt_id:
        raise HTTPException(502, "Payment provider returned a different checkout")
    if active.stripe_payment_intent_id and active.stripe_payment_intent_id != returned_id:
        raise HTTPException(409, "Checkout intent mismatch")
    active.stripe_payment_intent_id = returned_id
    if active.state == "creating":
        active.state = "pending"
    session.add(active)
    session.commit()
    if field(intent, "status") == "succeeded":
        return {**settle(session, attempt_id, intent, sid), "amount": 0}
    if field(intent, "status") == "canceled" and not field(intent, "amount_received", 0):
        lock_order(session, order.id)
        active = session.get(models.GuestPaymentAttempt, attempt_id, populate_existing=True)
        if active.state in {"creating", "pending", "processing"}:
            active.state = "cancelled"
            session.add(active)
            session.commit()
        raise HTTPException(409, "Checkout was cancelled. Refresh before trying again.")
    return {"client_secret": field(intent, "client_secret"), "payment_intent_id": returned_id,
            "amount": amount, "status": field(intent, "status"), "payment_scope": "session_items"}


def cancel(session: Session, order: models.Order, table: models.Table, sid: str,
           intent_id: str, options: dict) -> dict:
    order = lock_order(session, order.id)
    validate_table(order, table)
    attempt = session.exec(select(models.GuestPaymentAttempt).where(
        models.GuestPaymentAttempt.order_id == order.id,
        models.GuestPaymentAttempt.tenant_id == order.tenant_id,
        models.GuestPaymentAttempt.stripe_payment_intent_id == intent_id,
    )).first()
    if not attempt or attempt.session_hash != session_hash(sid):
        raise HTTPException(403, "Checkout does not belong to this customer")
    if attempt.state == "succeeded":
        return {"status": "paid"}
    if attempt.state == "cancelled":
        return {"status": "cancelled"}
    if attempt.state in REFUNDED or attempt.account_binding != account_binding(options):
        raise HTTPException(409, "Checkout requires staff reconciliation")
    attempt_id = attempt.id
    session.commit()
    intent = stripe.PaymentIntent.retrieve(intent_id, **options)
    bound = lookup(session, intent, order.tenant_id)
    if bound is None or bound.id != attempt_id:
        raise HTTPException(400, "Payment provider returned a different checkout")
    session.commit()
    if field(intent, "status") == "succeeded":
        return settle(session, attempt_id, intent, sid)
    if field(intent, "status") != "canceled":
        try:
            intent = stripe.PaymentIntent.cancel(intent_id, idempotency_key=f"guest-cancel-{attempt_id}", **options)
        except stripe.error.InvalidRequestError:
            # Capture can win the provider-side race; never pretend it was cancelled.
            intent = stripe.PaymentIntent.retrieve(intent_id, **options)
    if field(intent, "status") == "succeeded":
        return settle(session, attempt_id, intent, sid)
    if field(intent, "status") != "canceled" or field(intent, "amount_received", 0):
        raise HTTPException(409, "Cancellation was not confirmed; checkout remains reserved")
    webhook(session, order.tenant_id, "payment_intent.canceled", intent)
    return {"status": "cancelled"}


def lookup(session: Session, intent: object, tenant_id: int):
    metadata = field(intent, "metadata", {}) or {}
    key = field(metadata, "guest_payment_attempt_id")
    intent_id = field(intent, "id")
    if key is not None and not isinstance(key, str):
        raise HTTPException(400, "Invalid customer checkout binding")
    row = session.exec(select(models.GuestPaymentAttempt).where(
        models.GuestPaymentAttempt.tenant_id == tenant_id,
        models.GuestPaymentAttempt.id == key,
    )).first() if key else None
    if key and row is None:
        raise HTTPException(400, "Unrecognized customer checkout")
    if row and (str(field(metadata, "tenant_id")) != str(row.tenant_id)
                or str(field(metadata, "order_id")) != str(row.order_id)
                or field(metadata, "payment_account_snapshot") != row.account_binding
                or field(intent, "amount") != row.amount_cents
                or field(intent, "currency") != row.currency):
        raise HTTPException(400, "Customer checkout binding mismatch")
    if row and row.stripe_payment_intent_id not in (None, intent_id):
        raise HTTPException(400, "Checkout intent mismatch")
    return row


def settle(session: Session, attempt_id: str, intent: object, sid: str | None = None) -> dict:
    initial = session.get(models.GuestPaymentAttempt, attempt_id)
    if not initial:
        raise HTTPException(404, "Checkout not found")
    order = lock_order(session, initial.order_id)
    attempt = session.get(models.GuestPaymentAttempt, attempt_id, populate_existing=True)
    metadata = field(intent, "metadata", {}) or {}
    if sid is not None and attempt.session_hash != session_hash(sid):
        raise HTTPException(403, "Checkout belongs to another session")
    if (field(intent, "status") != "succeeded"
            or type(field(intent, "amount")) is not int
            or type(field(intent, "amount_received")) is not int
            or field(intent, "amount") != attempt.amount_cents
            or field(intent, "amount_received") != attempt.amount_cents
            or field(intent, "currency") != attempt.currency
            or str(field(metadata, "order_id")) != str(order.id)
            or str(field(metadata, "tenant_id")) != str(order.tenant_id)
            or field(metadata, "guest_payment_attempt_id") != attempt.id
            or field(metadata, "payment_account_snapshot") != attempt.account_binding
            or attempt.stripe_payment_intent_id not in (None, field(intent, "id"))):
        raise HTTPException(400, "Payment does not match reserved customer checkout")
    if attempt.state in REFUNDED:
        raise HTTPException(409, "Refunded checkout requires staff reconciliation")
    if attempt.state != "succeeded":
        selected = {i.id: i for i in payments.active_order_items(session, order.id)}
        if (any(i not in selected for i in attempt.item_ids)
                or sum(selected[i].price_cents * selected[i].quantity for i in attempt.item_ids) != attempt.amount_cents):
            attempt.state = "requires_staff_reconciliation"
            session.add(attempt)
            order.flagged_for_review = True
            order.flag_reason = "Captured customer payment requires reconciliation before further checkout."
            order.payment_state = "requires_staff_reconciliation"
            session.add(order)
            session.commit()
            raise HTTPException(409, "Captured payment requires staff reconciliation")
        attempt.stripe_payment_intent_id = field(intent, "id")
        attempt.state = "succeeded"
        session.add(attempt)
        session.flush()
        payments.record_payment(
            session, order=order, amount_cents=attempt.amount_cents,
            payment_method="stripe", paid_by_user_id=None,
            stripe_payment_intent_id=field(intent, "id"), order_item_ids=attempt.item_ids,
            guest_attempt_id=attempt.id,
        )
    return {"status": "paid", "order_id": order.id,
            "order_fully_paid": order.paid_at is not None,
            "kitchen_released": order.kitchen_released_at is not None}


def webhook(session: Session, tenant_id: int, event_type: str, obj: object):
    if event_type == "charge.refunded":
        row = session.exec(select(models.GuestPaymentAttempt).where(
            models.GuestPaymentAttempt.tenant_id == tenant_id,
            models.GuestPaymentAttempt.stripe_payment_intent_id == field(obj, "payment_intent"),
        )).first()
        if not row:
            return None
        order = lock_order(session, row.order_id)
        row = session.get(models.GuestPaymentAttempt, row.id, populate_existing=True)
        amount = field(obj, "amount_refunded")
        if (type(amount) is not int or not 0 < amount <= row.amount_cents
                or field(obj, "amount") != row.amount_cents or field(obj, "currency") != row.currency):
            raise HTTPException(400, "Refund does not match customer payment")
        prior_refund = row.refunded_amount_cents
        row.refunded_amount_cents = max(prior_refund, amount)
        # Keep the original ledger intact; do not free items for accidental recharging.
        row.state = "requires_staff_reconciliation"
        session.add(row)
        order.refunded_amount_cents = (order.refunded_amount_cents or 0) + row.refunded_amount_cents - prior_refund
        order.payment_state = "requires_staff_reconciliation"
        order.flagged_for_review = True
        order.flag_reason = "Customer item payment refunded; reconcile the captured and refunded amounts."
        session.add(order)
        session.commit()
        return {"received": True, "handled": True, "requires_staff_reconciliation": True}
    row = lookup(session, obj, tenant_id)
    if not row:
        return None
    if event_type == "payment_intent.succeeded":
        return {"received": True, "handled": True, **settle(session, row.id, obj)}
    if event_type == "payment_intent.canceled" and field(obj, "status") == "canceled" and not field(obj, "amount_received", 0):
        lock_order(session, row.order_id)
        row = session.get(models.GuestPaymentAttempt, row.id, populate_existing=True)
        if row.state in {"creating", "pending", "processing"}:
            row.state = "cancelled"
            session.add(row)
            session.commit()
    elif event_type == "payment_intent.processing" and field(obj, "status") == "processing":
        lock_order(session, row.order_id)
        row = session.get(models.GuestPaymentAttempt, row.id, populate_existing=True)
        if row.state in {"creating", "pending"}:
            row.state = "processing"
            session.add(row)
            session.commit()
    return {"received": True, "handled": True}
