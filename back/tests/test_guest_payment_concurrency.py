"""Real independent PostgreSQL transactions, not shared-session thread mocks."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
import unittest

from sqlmodel import Session, select

from app import models, guest_payment_service as guest
from app.db import engine


class TestGuestPaymentConcurrency(unittest.TestCase):
    def test_confirm_and_webhook_allocate_exactly_once(self):
        marker = str(uuid4())
        tenant_id = None
        with Session(engine) as session:
            tenant = models.Tenant(name="Concurrent payment " + marker)
            session.add(tenant)
            session.flush()
            tenant_id = tenant.id
            table = models.Table(name="Concurrent", tenant_id=tenant.id)
            product = models.Product(name="Dish", price_cents=500, tenant_id=tenant.id)
            session.add_all([table, product])
            session.flush()
            order = models.Order(tenant_id=tenant.id, table_id=table.id)
            session.add(order)
            session.flush()
            item = models.OrderItem(order_id=order.id, product_id=product.id, product_name="Dish",
                                   quantity=1, price_cents=500, added_by_session="race-browser")
            session.add(item)
            session.flush()
            attempt = models.GuestPaymentAttempt(tenant_id=tenant.id, order_id=order.id,
                session_hash=guest.session_hash("race-browser"), item_ids=[item.id],
                amount_cents=500, currency="gbp", account_binding="tenant-default",
                stripe_payment_intent_id="pi_" + marker, state="pending")
            session.add(attempt)
            session.flush()
            attempt_id, order_id = attempt.id, order.id
            obj = {"id": attempt.stripe_payment_intent_id, "status": "succeeded",
                "amount": 500, "amount_received": 500, "currency": "gbp", "metadata": {
                    "guest_payment_attempt_id": attempt.id, "order_id": str(order.id),
                    "tenant_id": str(tenant.id), "payment_account_snapshot": "tenant-default"}}
            session.commit()
        try:
            barrier = Barrier(2)
            def invoke(webhook):
                with Session(engine) as session:
                    barrier.wait(timeout=10)
                    if webhook:
                        return guest.webhook(session, tenant_id, "payment_intent.succeeded", obj)
                    return guest.settle(session, attempt_id, obj, "race-browser")
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(invoke, flag) for flag in (False, True)]
                results = [f.result(timeout=20) for f in futures]
            self.assertEqual([r["status"] for r in results], ["paid", "paid"])
            with Session(engine) as session:
                legs = session.exec(select(models.OrderPayment).where(models.OrderPayment.order_id == order_id)).all()
                self.assertEqual(len(legs), 1)
                allocations = session.exec(select(models.OrderPaymentItem).where(
                    models.OrderPaymentItem.order_payment_id == legs[0].id)).all()
                self.assertEqual(len(allocations), 1)
                self.assertEqual(allocations[0].amount_cents, 500)
        finally:
            # Only this committed synthetic tenant; no shared fixtures or live databases.
            with Session(engine) as session:
                for model in (models.OrderPaymentItem, models.OrderPayment, models.GuestPaymentAttempt):
                    for row in session.exec(select(model).where(model.tenant_id == tenant_id)).all():
                        session.delete(row)
                    session.flush()
                for row in session.exec(select(models.OrderItem).where(models.OrderItem.order_id == order_id)).all():
                    session.delete(row)
                session.flush()
                for model in (models.Order, models.Product, models.Table):
                    for row in session.exec(select(model).where(model.tenant_id == tenant_id)).all():
                        session.delete(row)
                    session.flush()
                session.delete(session.get(models.Tenant, tenant_id))
                session.commit()
