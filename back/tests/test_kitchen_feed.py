from __future__ import annotations

from datetime import datetime, timedelta, timezone

from pg_client_mixin import PgClientTestCase

from app import models, security
from app.security import get_password_hash


def _headers(user: models.User) -> dict[str, str]:
    token = security.create_access_token(
        {
            "sub": user.email,
            "tenant_id": user.tenant_id,
            "provider_id": None,
            "token_version": user.token_version,
        },
        expires_delta=timedelta(minutes=10),
    )
    return {"Authorization": f"Bearer {token}"}


class TestKitchenFeed(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        tenant = models.Tenant(name="Kitchen Feed Test", kds_routing_mode="kitchen_all")
        self.session.add(tenant)
        self.session.commit()
        self.session.refresh(tenant)
        self.tenant = tenant
        self.user = models.User(
            email="kitchen-feed@amvara.de",
            hashed_password=get_password_hash("secret"),
            tenant_id=tenant.id,
            role=models.UserRole.kitchen,
        )
        location = models.TenantLocation(
            tenant_id=tenant.id,
            name="Lounge",
            display_name="Sports Lounge",
            slug="sports-lounge",
        )
        self.session.add(self.user)
        self.session.add(location)
        self.session.commit()
        self.session.refresh(self.user)
        self.session.refresh(location)
        table = models.Table(
            tenant_id=tenant.id,
            name="Table 1",
            location_id=location.id,
            is_ordering_enabled=True,
        )
        product = models.Product(
            tenant_id=tenant.id,
            name="Kitchen item",
            category="Main Course",
            price_cents=900,
        )
        self.session.add(table)
        self.session.add(product)
        self.session.commit()
        self.session.refresh(table)
        self.session.refresh(product)
        self.table = table
        self.product = product

    def _order(
        self,
        *,
        status: models.OrderStatus,
        item_status: models.OrderItemStatus,
        released: bool = True,
    ) -> models.Order:
        now = datetime.now(timezone.utc)
        order = models.Order(
            tenant_id=self.tenant.id,
            table_id=self.table.id,
            location_id=self.table.location_id,
            location_name_snapshot="Sports Lounge",
            service_point_type_snapshot="table",
            service_point_label_snapshot="Table 1",
            status=status,
            paid_at=now if status == models.OrderStatus.paid else None,
            requires_prepayment=True,
            kitchen_released_at=now if released else None,
            payment_state="succeeded" if released else "pending",
        )
        self.session.add(order)
        self.session.flush()
        self.session.add(
            models.OrderItem(
                order_id=order.id,
                product_id=self.product.id,
                product_name=self.product.name,
                quantity=1,
                price_cents=self.product.price_cents,
                status=item_status,
            )
        )
        self.session.commit()
        self.session.refresh(order)
        return order

    def test_feed_returns_only_released_active_work(self) -> None:
        active = self._order(
            status=models.OrderStatus.paid,
            item_status=models.OrderItemStatus.pending,
        )
        self._order(
            status=models.OrderStatus.completed,
            item_status=models.OrderItemStatus.delivered,
        )
        self._order(
            status=models.OrderStatus.pending,
            item_status=models.OrderItemStatus.pending,
            released=False,
        )

        response = self.client.get("/orders/kitchen-feed", headers=_headers(self.user))

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 1)
        row = response.json()[0]
        self.assertEqual(row["id"], active.id)
        self.assertEqual(row["location_name"], "Sports Lounge")
        self.assertEqual(row["service_point_label"], "Table 1")
        self.assertEqual(row["items"][0]["product_name"], "Kitchen item")
        self.assertEqual(row["items"][0]["kitchen_station_route"], "kitchen")

    def test_feed_limit_is_enforced(self) -> None:
        for _ in range(4):
            self._order(
                status=models.OrderStatus.paid,
                item_status=models.OrderItemStatus.pending,
            )
        response = self.client.get(
            "/orders/kitchen-feed",
            params={"limit": 2},
            headers=_headers(self.user),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 2)
