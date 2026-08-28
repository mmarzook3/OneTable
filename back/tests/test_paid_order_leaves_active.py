"""Paid + fully delivered orders become completed (GitHub #345)."""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from pg_client_mixin import PgClientTestCase
from sqlmodel import select

from app import models, security
from app.security import get_password_hash


def _bearer_headers(user: models.User) -> dict[str, str]:
    data = {
        "sub": user.email,
        "tenant_id": user.tenant_id,
        "provider_id": getattr(user, "provider_id", None),
        "token_version": user.token_version,
    }
    token = security.create_access_token(data, expires_delta=timedelta(minutes=30))
    return {"Authorization": f"Bearer {token}"}


class TestPaidOrderLeavesActive(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        tenant = models.Tenant(name="Active Leave Test", tip_preset_percents=[10])
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)

        self.owner = models.User(
            email="active-leave-owner@test.local",
            hashed_password=get_password_hash("secret"),
            full_name="Owner O",
            tenant_id=tenant.id,
            role=models.UserRole.owner,
        )
        self.session.add(self.owner)
        self.session.commit()
        self.session.refresh(self.owner)

        floor = models.Floor(name="Main", tenant_id=tenant.id)
        self.session.add(floor)
        self.session.commit()
        self.session.refresh(floor)

        table = models.Table(
            name="T1",
            tenant_id=tenant.id,
            floor_id=floor.id,
            is_active=True,
        )
        self.session.add(table)
        self.session.commit()
        self.session.refresh(table)
        self.table = table

        product = models.Product(
            name="Soup",
            price_cents=500,
            tenant_id=tenant.id,
        )
        self.session.add(product)
        self.session.commit()
        self.session.refresh(product)
        self.product = product

    def _order_with_item(self, *, item_status: models.OrderItemStatus) -> models.Order:
        order = models.Order(
            table_id=self.table.id,
            tenant_id=self.owner.tenant_id,
            status=models.OrderStatus.preparing,
        )
        self.session.add(order)
        self.session.commit()
        self.session.refresh(order)
        item = models.OrderItem(
            order_id=order.id,
            product_id=self.product.id,
            product_name=self.product.name,
            quantity=1,
            price_cents=self.product.price_cents,
            status=item_status,
        )
        self.session.add(item)
        self.session.commit()
        self.session.refresh(order)
        return order

    def test_finish_sets_completed_when_all_delivered(self) -> None:
        order = self._order_with_item(item_status=models.OrderItemStatus.preparing)
        h = _bearer_headers(self.owner)
        r = self.client.put(
            f"/orders/{order.id}/finish",
            json={"payment_method": "cash", "tip_percent": None},
            headers=h,
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json().get("status"), "paid")

        self.session.refresh(order)
        self.assertEqual(order.status, models.OrderStatus.completed)
        self.assertIsNotNone(order.paid_at)

        item = self.session.exec(
            select(models.OrderItem).where(models.OrderItem.order_id == order.id)
        ).first()
        assert item is not None
        self.assertEqual(item.status, models.OrderItemStatus.delivered)

    def test_mark_paid_all_delivered_becomes_completed(self) -> None:
        order = self._order_with_item(item_status=models.OrderItemStatus.delivered)
        order.status = models.OrderStatus.completed
        self.session.add(order)
        self.session.commit()

        h = _bearer_headers(self.owner)
        r = self.client.put(
            f"/orders/{order.id}/mark-paid",
            json={"payment_method": "cash", "tip_percent": None},
            headers=h,
        )
        self.assertEqual(r.status_code, 200, r.text)

        self.session.refresh(order)
        self.assertEqual(order.status, models.OrderStatus.completed)
        self.assertIsNotNone(order.paid_at)

    def test_prepay_then_deliver_advances_to_completed(self) -> None:
        order = self._order_with_item(item_status=models.OrderItemStatus.preparing)
        h = _bearer_headers(self.owner)
        r = self.client.put(
            f"/orders/{order.id}/mark-paid",
            json={"payment_method": "cash", "tip_percent": None},
            headers=h,
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.session.refresh(order)
        self.assertEqual(order.status, models.OrderStatus.paid)

        item = self.session.exec(
            select(models.OrderItem).where(models.OrderItem.order_id == order.id)
        ).first()
        assert item is not None
        r2 = self.client.put(
            f"/orders/{order.id}/items/{item.id}/status",
            json={"status": "delivered"},
            headers=h,
        )
        self.assertEqual(r2.status_code, 200, r2.text)
        self.assertEqual(r2.json().get("order_status"), "completed")

        self.session.refresh(order)
        self.assertEqual(order.status, models.OrderStatus.completed)
        self.assertIsNotNone(order.paid_at)

    def test_kitchen_can_restore_completed_order_to_new_and_complete_again(self) -> None:
        kitchen = models.User(
            email="kitchen-status-correction@test.local",
            hashed_password=get_password_hash("secret"),
            full_name="Kitchen Status Correction",
            tenant_id=self.owner.tenant_id,
            role=models.UserRole.kitchen,
        )
        self.session.add(kitchen)
        self.session.commit()
        self.session.refresh(kitchen)

        order = self._order_with_item(item_status=models.OrderItemStatus.delivered)
        order.status = models.OrderStatus.completed
        order.paid_at = datetime.now(timezone.utc)
        self.session.add(order)
        self.session.commit()
        item = self.session.exec(
            select(models.OrderItem).where(models.OrderItem.order_id == order.id)
        ).one()
        item.prepared_by_user_id = self.owner.id
        item.delivered_by_user_id = self.owner.id
        self.session.add(item)
        self.session.commit()

        h = _bearer_headers(kitchen)
        restored = self.client.put(
            f"/orders/{order.id}/kitchen-status",
            json={"status": "pending"},
            headers=h,
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json().get("updated_items"), 1)
        self.assertEqual(restored.json().get("order_status"), "paid")

        self.session.refresh(order)
        self.session.refresh(item)
        self.assertEqual(order.status, models.OrderStatus.paid)
        self.assertIsNotNone(order.paid_at)
        self.assertEqual(item.status, models.OrderItemStatus.pending)
        self.assertIsNone(item.prepared_by_user_id)
        self.assertIsNone(item.delivered_by_user_id)

        completed = self.client.put(
            f"/orders/{order.id}/kitchen-status",
            json={"status": "delivered"},
            headers=h,
        )
        self.assertEqual(completed.status_code, 200, completed.text)
        self.assertEqual(completed.json().get("order_status"), "completed")
        self.session.refresh(order)
        self.session.refresh(item)
        self.assertEqual(order.status, models.OrderStatus.completed)
        self.assertEqual(item.status, models.OrderItemStatus.delivered)
        self.assertEqual(item.delivered_by_user_id, kitchen.id)

    def test_atomic_kitchen_status_updates_a_15_item_ticket(self) -> None:
        order = models.Order(
            table_id=self.table.id,
            tenant_id=self.owner.tenant_id,
            status=models.OrderStatus.paid,
            paid_at=datetime.now(timezone.utc),
        )
        self.session.add(order)
        self.session.commit()
        self.session.refresh(order)
        for index in range(15):
            self.session.add(
                models.OrderItem(
                    order_id=order.id,
                    product_id=self.product.id,
                    product_name=f"Long ticket item {index + 1}",
                    quantity=1,
                    price_cents=self.product.price_cents,
                    status=models.OrderItemStatus.pending,
                )
            )
        self.session.commit()

        response = self.client.put(
            f"/orders/{order.id}/kitchen-status",
            json={"status": "preparing"},
            headers=_bearer_headers(self.owner),
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json().get("updated_items"), 15)
        items = self.session.exec(
            select(models.OrderItem).where(models.OrderItem.order_id == order.id)
        ).all()
        self.assertEqual(len(items), 15)
        self.assertTrue(all(item.status == models.OrderItemStatus.preparing for item in items))

    def test_active_only_orders_excludes_completed_history(self) -> None:
        active = self._order_with_item(item_status=models.OrderItemStatus.pending)
        completed = self._order_with_item(item_status=models.OrderItemStatus.delivered)
        completed.status = models.OrderStatus.completed
        completed.paid_at = datetime.now(timezone.utc)
        self.session.add(completed)
        self.session.commit()

        response = self.client.get(
            "/orders",
            params={"active_only": "true"},
            headers=_bearer_headers(self.owner),
        )

        self.assertEqual(response.status_code, 200, response.text)
        ids = {row["id"] for row in response.json()}
        self.assertIn(active.id, ids)
        self.assertNotIn(completed.id, ids)

    def test_cancelled_order_cannot_be_restored_from_kitchen(self) -> None:
        order = self._order_with_item(item_status=models.OrderItemStatus.cancelled)
        order.status = models.OrderStatus.cancelled
        self.session.add(order)
        self.session.commit()

        response = self.client.put(
            f"/orders/{order.id}/kitchen-status",
            json={"status": "pending"},
            headers=_bearer_headers(self.owner),
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("Cancelled orders", response.json().get("detail", ""))


if __name__ == "__main__":
    unittest.main()
