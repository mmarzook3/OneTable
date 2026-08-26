from __future__ import annotations

from datetime import timedelta
import uuid

from sqlmodel import select

from pg_client_mixin import PgClientTestCase

from app import models, security


def _headers(user: models.User) -> dict[str, str]:
    token = security.create_access_token(
        {
            "sub": user.email,
            "tenant_id": user.tenant_id,
            "provider_id": None,
            "token_version": user.token_version,
        },
        expires_delta=timedelta(minutes=30),
    )
    return {"Authorization": f"Bearer {token}"}


class TestKitchenStockAvailability(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        suffix = uuid.uuid4().hex[:8]
        self.tenant = models.Tenant(name=f"Kitchen Stock {suffix}")
        self.other_tenant = models.Tenant(name=f"Other Stock {suffix}")
        self.session.add(self.tenant)
        self.session.add(self.other_tenant)
        self.session.commit()
        self.session.refresh(self.tenant)
        self.session.refresh(self.other_tenant)
        self.station = models.KitchenStation(
            tenant_id=self.tenant.id,
            name="Main kitchen",
            display_route="kitchen",
        )
        self.session.add(self.station)
        self.session.commit()
        self.session.refresh(self.station)
        self.tenant.default_kitchen_station_id = self.station.id
        self.table = models.Table(
            tenant_id=self.tenant.id,
            name="Kitchen stock table",
            is_active=True,
        )
        self.product = models.Product(
            tenant_id=self.tenant.id,
            name="Kitchen pie",
            price_cents=1295,
            category="Main Course",
            is_available=True,
        )
        self.other_product = models.Product(
            tenant_id=self.other_tenant.id,
            name="Other tenant pie",
            price_cents=995,
            category="Main Course",
            is_available=True,
        )
        catalog = models.ProductCatalog(name=f"Kitchen pie catalog {suffix}")
        self.session.add(self.table)
        self.session.add(self.product)
        self.session.add(self.other_product)
        self.session.add(catalog)
        self.session.commit()
        self.session.refresh(self.product)
        self.session.refresh(self.other_product)
        self.session.refresh(self.table)
        self.session.refresh(catalog)
        self.tenant_product = models.TenantProduct(
            tenant_id=self.tenant.id,
            catalog_id=catalog.id,
            product_id=self.product.id,
            name=self.product.name,
            price_cents=self.product.price_cents,
            is_active=True,
        )
        self.kitchen = models.User(
            email=f"kitchen-stock-{suffix}@amvara.de",
            hashed_password=security.get_password_hash("kitchen-test-password"),
            role=models.UserRole.kitchen,
            tenant_id=self.tenant.id,
        )
        self.waiter = models.User(
            email=f"waiter-stock-{suffix}@amvara.de",
            hashed_password=security.get_password_hash("waiter-test-password"),
            role=models.UserRole.waiter,
            tenant_id=self.tenant.id,
        )
        self.session.add(self.tenant)
        self.session.add(self.tenant_product)
        self.session.add(self.kitchen)
        self.session.add(self.waiter)
        self.session.commit()
        for row in (self.tenant_product, self.kitchen, self.waiter):
            self.session.refresh(row)

    def test_kitchen_can_list_resolved_stock_and_change_availability_only(self) -> None:
        listed = self.client.get("/products/availability", headers=_headers(self.kitchen))
        self.assertEqual(listed.status_code, 200, listed.text)
        item = next(row for row in listed.json() if row["id"] == self.product.id)
        self.assertEqual(item["kitchen_station_route"], "kitchen")
        self.assertEqual(item["resolved_kitchen_station_id"], self.station.id)
        self.assertTrue(item["is_available"])

        changed = self.client.put(
            "/products/availability",
            headers=_headers(self.kitchen),
            json={"items": [{"product_id": self.product.id, "is_available": False}]},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertFalse(changed.json()[0]["is_available"])
        self.session.refresh(self.product)
        self.session.refresh(self.tenant_product)
        self.assertFalse(self.product.is_available)
        self.assertFalse(self.tenant_product.is_active)

        customer_menu = self.client.get(f"/menu/{self.table.token}")
        self.assertEqual(customer_menu.status_code, 200, customer_menu.text)
        self.assertNotIn(
            self.product.id,
            [row.get("product_id", row["id"]) for row in customer_menu.json()["products"]],
        )

        price_edit = self.client.put(
            f"/products/{self.product.id}",
            headers=_headers(self.kitchen),
            json={"price_cents": 1},
        )
        self.assertEqual(price_edit.status_code, 403, price_edit.text)
        self.session.refresh(self.product)
        self.assertEqual(self.product.price_cents, 1295)

    def test_waiter_cannot_change_stock(self) -> None:
        response = self.client.put(
            "/products/availability",
            headers=_headers(self.waiter),
            json={"items": [{"product_id": self.product.id, "is_available": False}]},
        )
        self.assertEqual(response.status_code, 403, response.text)

    def test_cross_tenant_stock_update_is_rejected_atomically(self) -> None:
        response = self.client.put(
            "/products/availability",
            headers=_headers(self.kitchen),
            json={
                "items": [
                    {"product_id": self.product.id, "is_available": False},
                    {"product_id": self.other_product.id, "is_available": False},
                ]
            },
        )
        self.assertEqual(response.status_code, 404, response.text)
        self.session.refresh(self.product)
        self.session.refresh(self.other_product)
        self.assertTrue(self.product.is_available)
        self.assertTrue(self.other_product.is_available)

    def test_duplicate_product_update_is_rejected(self) -> None:
        response = self.client.put(
            "/products/availability",
            headers=_headers(self.kitchen),
            json={
                "items": [
                    {"product_id": self.product.id, "is_available": False},
                    {"product_id": self.product.id, "is_available": True},
                ]
            },
        )
        self.assertEqual(response.status_code, 400, response.text)
