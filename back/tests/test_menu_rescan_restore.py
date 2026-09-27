"""Session-owned customer tracking survives payment and QR rescans."""
from datetime import datetime, timezone

from pg_client_mixin import PgClientTestCase
from app import models


class TestMenuRescanRestore(PgClientTestCase):
    def setUp(self):
        super().setUp()
        self.tenant = models.Tenant(name="Rescan fixture")
        self.session.add(self.tenant)
        self.session.flush()
        self.table = models.Table(name="Rescan", tenant_id=self.tenant.id)
        self.product = models.Product(name="Dish", price_cents=500, tenant_id=self.tenant.id)
        self.session.add_all([self.table, self.product])
        self.session.flush()
        self.sid = "rescan-browser-session"
        self.order = models.Order(
            tenant_id=self.tenant.id, table_id=self.table.id,
            session_id=self.sid, status=models.OrderStatus.paid,
            paid_at=datetime.now(timezone.utc),
            ordering_point_assignment_version_snapshot=1,
        )
        self.session.add(self.order)
        self.session.flush()
        self.item = models.OrderItem(
            order_id=self.order.id, product_id=self.product.id, product_name="Dish",
            quantity=1, price_cents=500, status=models.OrderItemStatus.preparing,
            added_by_session=self.sid,
        )
        self.session.add(self.item)
        self.table.active_order_id = self.order.id
        self.session.commit()

    def fetch(self, sid=None, token=None):
        response = self.client.get(
            f"/menu/{token or self.table.token}/order",
            params={} if sid is None else {"session_id": sid},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers.get("cache-control"), "private, no-store")
        return response.json()

    def test_paid_preparing_survives_rescan_and_active_pointer_reset(self):
        self.table.active_order_id = None
        self.session.commit()
        for _ in range(2):
            data = self.fetch(self.sid)
            self.assertEqual(data["order"]["id"], self.order.id)
            self.assertEqual(data["order"]["status"], "preparing")
            self.assertIsNotNone(data["order"]["paid_at"])
            self.assertEqual(data["orders"], [data["order"]])

    def test_completed_is_restored(self):
        self.order.status = models.OrderStatus.completed
        self.item.status = models.OrderItemStatus.delivered
        self.session.commit()
        self.assertEqual(self.fetch(self.sid)["order"]["items"][0]["status"], "delivered")

    def test_history_hides_previous_assignment(self):
        self.table.assignment_version = 2
        self.session.commit()
        response = self.client.get(
            f"/menu/{self.table.token}/order-history", params={"session_id": self.sid},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), [])
        self.assertEqual(response.headers.get("cache-control"), "private, no-store")

    def test_restore_is_bounded_to_latest_fifty_owned_orders(self):
        for _ in range(51):
            order = models.Order(
                tenant_id=self.tenant.id, table_id=self.table.id, session_id=self.sid,
                ordering_point_assignment_version_snapshot=1,
            )
            self.session.add(order)
            self.session.flush()
            self.session.add(models.OrderItem(
                order_id=order.id, product_id=self.product.id, product_name="Dish",
                quantity=1, price_cents=500, added_by_session=self.sid,
            ))
        self.session.commit()
        data = self.fetch(self.sid)
        self.assertEqual(len(data["orders"]), 50)
        self.assertNotIn(self.order.id, [row["id"] for row in data["orders"]])

    def test_missing_blank_and_other_session_never_use_shared_pointer(self):
        for sid in (None, "", "   ", "another-browser"):
            self.assertEqual(self.fetch(sid), {"order": None, "orders": []})

    def test_reassigned_plaque_hides_previous_assignment(self):
        self.table.assignment_version = 2
        self.session.commit()
        self.assertEqual(self.fetch(self.sid)["orders"], [])

    def test_legacy_snapshot_hidden_after_reassignment(self):
        self.order.ordering_point_assignment_version_snapshot = None
        self.session.commit()
        self.assertIsNotNone(self.fetch(self.sid)["order"])
        self.table.assignment_version = 2
        self.session.commit()
        self.assertEqual(self.fetch(self.sid)["orders"], [])

    def test_wrong_table_and_cross_tenant_hidden(self):
        other = models.Table(name="Other", tenant_id=self.tenant.id)
        tenant = models.Tenant(name="Other tenant")
        self.session.add_all([other, tenant])
        self.session.commit()
        self.assertEqual(self.fetch(self.sid, other.token)["orders"], [])
        self.order.tenant_id = tenant.id
        self.session.commit()
        self.assertEqual(self.fetch(self.sid)["orders"], [])

    def test_shared_contributor_sees_only_own_items_and_no_owner_identity(self):
        self.order.session_id = "other-owner-session"
        self.order.customer_name = "Private owner"
        self.order.notes = "Private notes"
        self.session.add(models.OrderItem(
            order_id=self.order.id, product_id=self.product.id, product_name="Private dish",
            quantity=2, price_cents=500, added_by_session="other-owner-session",
        ))
        self.session.commit()
        data = self.fetch(self.sid)["order"]
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["total_cents"], 500)
        self.assertIsNone(data["customer_name"])
        self.assertIsNone(data["notes"])
        self.assertEqual(data["session_id"], self.sid)
