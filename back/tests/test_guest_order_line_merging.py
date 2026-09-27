"""Exercise real public ordering, not synthetic order-line insertion."""
from unittest.mock import patch

from sqlmodel import select
from pg_client_mixin import PgClientTestCase
from app import models, order_payment_service as payments


class TestGuestOrderLineMerging(PgClientTestCase):
    def setUp(self):
        super().setUp()
        self.tenant = models.Tenant(name="Line ownership", stripe_secret_key="sk_test_fixture", currency_code="GBP")
        self.session.add(self.tenant)
        self.session.flush()
        self.table = models.Table(name="Shared table", tenant_id=self.tenant.id,
                                  is_active=True, order_pin="1234")
        self.product = models.Product(name="Same dish", price_cents=500, tenant_id=self.tenant.id)
        self.session.add_all([self.table, self.product])
        self.session.commit()

    def add(self, sid, quantity=1):
        response = self.client.post(f"/menu/{self.table.token}/order", json={
            "session_id": sid, "pin": "1234",
            "items": [{"product_id": self.product.id, "quantity": quantity, "notes": "Same note"}],
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["order_id"]

    def lines(self, order_id):
        self.session.expire_all()
        return self.session.exec(select(models.OrderItem).where(
            models.OrderItem.order_id == order_id).order_by(models.OrderItem.id)).all()

    def test_two_browsers_same_product_remain_distinct_and_pay_only_own_amount(self):
        order_id = self.add("browser-one", 1)
        self.assertEqual(self.add("browser-two", 2), order_id)
        lines = self.lines(order_id)
        self.assertEqual([(i.added_by_session, i.quantity) for i in lines],
                         [("browser-one", 1), ("browser-two", 2)])
        def provider(**kwargs):
            return {"id": "pi_" + kwargs["metadata"]["guest_payment_attempt_id"],
                "client_secret": "fixture_secret", "status": "requires_payment_method",
                "amount": kwargs["amount"], "amount_received": 0, "currency": kwargs["currency"],
                "metadata": kwargs["metadata"]}
        with patch("stripe.PaymentIntent.create", side_effect=provider):
            for sid, expected in [("browser-one", 500), ("browser-two", 1000)]:
                response = self.client.post(f"/orders/{order_id}/create-payment-intent",
                    params={"table_token": self.table.token, "session_id": sid})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["amount"], expected)

    def test_same_browser_add_after_partial_line_payment_creates_unpaid_line(self):
        order_id = self.add("browser-one")
        self.add("browser-two")
        first = self.lines(order_id)[0]
        first_id = first.id
        order = self.session.get(models.Order, order_id)
        payments.record_payment(self.session, order=order, amount_cents=500,
            order_item_ids=[first_id], payment_method="cash", paid_by_user_id=None)
        self.assertEqual(self.add("browser-one", 2), order_id)
        lines = self.lines(order_id)
        own = [i for i in lines if i.added_by_session == "browser-one"]
        self.assertEqual(len(own), 2)
        self.assertEqual(own[0].id, first_id)
        self.assertEqual(own[0].quantity, 1)
        self.assertEqual(own[1].quantity, 2)
        self.assertNotIn(own[1].id, payments.allocated_order_item_ids(self.session, order_id))

    def test_same_browser_unpaid_pending_still_merges(self):
        order_id = self.add("browser-one")
        original_id = self.lines(order_id)[0].id
        self.assertEqual(self.add("browser-one", 2), order_id)
        lines = self.lines(order_id)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0].id, original_id)
        self.assertEqual(lines[0].quantity, 3)

    def test_preparing_and_ready_lines_are_not_extended(self):
        for status in (models.OrderItemStatus.preparing, models.OrderItemStatus.ready):
            with self.subTest(status=status):
                sid = "browser-" + status.value
                order_id = self.add(sid)
                original = [i for i in self.lines(order_id) if i.added_by_session == sid][0]
                original.status = status
                original_id = original.id
                self.session.commit()
                self.add(sid, 2)
                own = [i for i in self.lines(order_id) if i.added_by_session == sid]
                self.assertEqual(len(own), 2)
                self.assertEqual((own[0].id, own[0].quantity, own[0].status), (original_id, 1, status))
                self.assertEqual((own[1].quantity, own[1].status), (2, models.OrderItemStatus.pending))
