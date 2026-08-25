from __future__ import annotations

from datetime import datetime, timedelta, timezone
import uuid
from zoneinfo import ZoneInfo

from sqlmodel import select

from pg_client_mixin import PgClientTestCase

from app import models, security
from app.location_service import service_point_label
from app.onetable_ordering import ordering_availability


def _headers(user: models.User) -> dict[str, str]:
    return {
        "Authorization": "Bearer "
        + security.create_access_token(
            {
                "sub": user.email,
                "tenant_id": user.tenant_id,
                "provider_id": None,
                "is_platform_operator": user.role == models.UserRole.platform_operator,
                "token_version": user.token_version,
            }
        )
    }


class TestMultiLocationOrdering(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        suffix = uuid.uuid4().hex[:8]
        self.tenant = models.Tenant(
            name=f"Location Hotel {suffix}",
            ordering_mode="automatic",
            immediate_payment_required=True,
            saas_plan_code="pro",
            saas_included_tables=20,
            timezone="Europe/London",
            ordering_service_hours={
                day: {"open": "00:00", "close": "23:59"}
                for day in (
                    "monday", "tuesday", "wednesday", "thursday",
                    "friday", "saturday", "sunday",
                )
            },
        )
        self.other_tenant = models.Tenant(name=f"Other Location {suffix}")
        self.session.add(self.tenant)
        self.session.add(self.other_tenant)
        self.session.commit()
        self.session.refresh(self.tenant)
        self.session.refresh(self.other_tenant)
        self.default_location = self.session.exec(
            select(models.TenantLocation).where(
                models.TenantLocation.tenant_id == self.tenant.id
            )
        ).first()
        self.other_location = self.session.exec(
            select(models.TenantLocation).where(
                models.TenantLocation.tenant_id == self.other_tenant.id
            )
        ).first()
        self.assertIsNotNone(self.default_location)
        self.assertIsNotNone(self.other_location)
        self.owner = models.User(
            email=f"location-owner-{suffix}@amvara.de",
            hashed_password=security.get_password_hash("location-owner-password"),
            role=models.UserRole.owner,
            tenant_id=self.tenant.id,
        )
        self.other_owner = models.User(
            email=f"other-location-owner-{suffix}@amvara.de",
            hashed_password=security.get_password_hash("other-location-password"),
            role=models.UserRole.owner,
            tenant_id=self.other_tenant.id,
        )
        self.product = models.Product(
            tenant_id=self.tenant.id,
            name="Hotel club sandwich",
            price_cents=1200,
            category="Mains",
            is_available=True,
        )
        self.session.add(self.owner)
        self.session.add(self.other_owner)
        self.session.add(self.product)
        self.session.commit()
        self.session.refresh(self.owner)
        self.session.refresh(self.other_owner)
        self.session.refresh(self.product)

    def _create_location(self, name: str, display: str, kind: str) -> dict:
        response = self.client.post(
            "/locations",
            headers=_headers(self.owner),
            json={"name": name, "display_name": display, "location_type": kind},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def _create_point(self, location_id: int, number: str, kind: str) -> dict:
        response = self.client.post(
            f"/locations/{location_id}/ordering-points",
            headers=_headers(self.owner),
            json={
                "display_number": number,
                "service_point_type": kind,
                "seat_count": 2,
                "is_ordering_enabled": True,
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_default_location_backfill_and_tenant_isolation(self) -> None:
        point = models.Table(
            tenant_id=self.tenant.id,
            name="Table 9",
            token="preserved-location-token",
        )
        self.session.add(point)
        self.session.commit()
        self.session.refresh(point)
        self.assertEqual(point.location_id, self.default_location.id)
        self.assertEqual(point.display_number, "9")
        self.assertEqual(point.token, "preserved-location-token")

        hidden = self.client.get(
            f"/locations/{self.other_location.id}", headers=_headers(self.owner)
        )
        self.assertEqual(hidden.status_code, 404)
        hidden_update = self.client.patch(
            f"/locations/{self.default_location.id}",
            headers=_headers(self.other_owner),
            json={"display_name": "Attack"},
        )
        self.assertEqual(hidden_update.status_code, 404)

    def test_room_context_menu_order_snapshot_and_stale_assignment(self) -> None:
        premium = self._create_location(
            "Premium Building", "Blaby Hotel - Premium Building", "hotel_building"
        )
        room = self._create_point(premium["id"], "212", "room")
        menu = self.client.get(f"/menu/{room['token']}")
        self.assertEqual(menu.status_code, 200, menu.text)
        payload = menu.json()
        self.assertEqual(payload["location_name"], "Blaby Hotel - Premium Building")
        self.assertEqual(payload["service_point_label"], "Room 212")
        self.assertEqual(
            payload["ordering_context_label"],
            "Ordering from Blaby Hotel - Premium Building - Room 212",
        )

        created = self.client.post(
            f"/menu/{room['token']}/order",
            json={
                "items": [{"product_id": self.product.id, "quantity": 1, "source": "product"}],
                "session_id": f"session-{uuid.uuid4().hex}",
                "idempotency_key": f"order-{uuid.uuid4().hex}",
                "ordering_point_assignment_version": payload["ordering_point_assignment_version"],
                "location_confirmed": True,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        order = self.session.get(models.Order, created.json()["order_id"])
        self.assertEqual(order.location_id, premium["id"])
        self.assertEqual(order.location_name_snapshot, "Blaby Hotel - Premium Building")
        self.assertEqual(order.service_point_type_snapshot, "room")
        self.assertEqual(order.service_point_label_snapshot, "Room 212")
        self.assertEqual(order.payment_account_snapshot, "tenant-default")

        moved = self.client.patch(
            f"/locations/{premium['id']}/ordering-points/{room['id']}",
            headers=_headers(self.owner),
            json={"display_number": "213"},
        )
        self.assertEqual(moved.status_code, 200, moved.text)
        stale = self.client.post(
            f"/menu/{room['token']}/order",
            json={
                "items": [{"product_id": self.product.id, "quantity": 1, "source": "product"}],
                "session_id": f"session-{uuid.uuid4().hex}",
                "idempotency_key": f"order-{uuid.uuid4().hex}",
                "ordering_point_assignment_version": payload["ordering_point_assignment_version"],
                "location_confirmed": True,
            },
        )
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["code"], "STALE_ORDERING_POINT")

    def test_location_menu_price_visibility_and_pause_precedence(self) -> None:
        lounge = self._create_location("Sports Lounge", "Sports Lounge", "lounge")
        table = self._create_point(lounge["id"], "7", "table")
        override = self.client.put(
            f"/locations/{lounge['id']}/menu/{self.product.id}",
            headers=_headers(self.owner),
            json={"source": "product", "enabled": True, "price_cents_override": 1450},
        )
        self.assertEqual(override.status_code, 200, override.text)
        menu = self.client.get(f"/menu/{table['token']}")
        product = next(row for row in menu.json()["products"] if row["id"] == self.product.id)
        self.assertEqual(product["price_cents"], 1450)

        placed = self.client.post(
            f"/menu/{table['token']}/order",
            json={
                "items": [{"product_id": self.product.id, "quantity": 1, "source": "product"}],
                "session_id": f"session-{uuid.uuid4().hex}",
                "idempotency_key": f"order-{uuid.uuid4().hex}",
                "ordering_point_assignment_version": table["assignment_version"],
                "location_confirmed": True,
            },
        )
        self.assertEqual(placed.status_code, 200, placed.text)
        item = self.session.exec(
            select(models.OrderItem).where(
                models.OrderItem.order_id == placed.json()["order_id"]
            )
        ).first()
        self.assertEqual(item.price_cents, 1450)

        pause = self.client.post(
            f"/locations/{lounge['id']}/pause",
            headers=_headers(self.owner),
            json={"reason": "Lounge kitchen closed"},
        )
        self.assertEqual(pause.status_code, 200)
        paused_menu = self.client.get(f"/menu/{table['token']}")
        self.assertFalse(paused_menu.json()["ordering_availability"]["allowed"])
        self.assertEqual(paused_menu.json()["ordering_availability"]["code"], "LOCATION_PAUSED")

        hidden = self.client.put(
            f"/locations/{lounge['id']}/menu/{self.product.id}",
            headers=_headers(self.owner),
            json={"source": "product", "enabled": False},
        )
        self.assertEqual(hidden.status_code, 200)
        hidden_menu = self.client.get(f"/menu/{table['token']}")
        self.assertNotIn(self.product.id, [row["id"] for row in hidden_menu.json()["products"]])

    def test_bulk_preview_capacity_routing_and_combined_reporting(self) -> None:
        main = self._create_location(
            "Main Building", "Blaby Hotel - Main Building", "hotel_building"
        )
        preview = self.client.post(
            f"/locations/{main['id']}/ordering-points/bulk/preview",
            headers=_headers(self.owner),
            json={"service_point_type": "room", "start_number": 101, "end_number": 103},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["labels"], ["Room 101", "Room 102", "Room 103"])
        self.assertTrue(preview.json()["allowed"])
        created = self.client.post(
            f"/locations/{main['id']}/ordering-points/bulk",
            headers=_headers(self.owner),
            json={"service_point_type": "room", "values": "101, 102\n104A"},
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(len(created.json()["ordering_points"]), 3)

        station = models.KitchenStation(
            tenant_id=self.tenant.id,
            name="Main kitchen",
            display_route="kitchen",
        )
        self.session.add(station)
        self.session.commit()
        self.session.refresh(station)
        route = self.client.put(
            f"/locations/{main['id']}/kitchen-routing",
            headers=_headers(self.owner),
            json={"mode": "override", "default_kitchen_station_id": station.id},
        )
        self.assertEqual(route.status_code, 200, route.text)
        payment = self.client.put(
            f"/locations/{main['id']}/payment-routing",
            headers=_headers(self.owner),
            json={"mode": "override", "payment_account_reference": "acct_future"},
        )
        self.assertEqual(payment.status_code, 409)

        first_point = created.json()["ordering_points"][0]
        order = models.Order(
            tenant_id=self.tenant.id,
            table_id=first_point["id"],
            location_id=main["id"],
            location_name_snapshot="Blaby Hotel - Main Building",
            service_point_type_snapshot="room",
            service_point_label_snapshot="Room 101",
            status=models.OrderStatus.paid,
            paid_at=datetime.now(timezone.utc),
        )
        self.session.add(order)
        self.session.flush()
        self.session.add(
            models.OrderItem(
                order_id=order.id,
                product_id=self.product.id,
                product_name=self.product.name,
                quantity=2,
                price_cents=1200,
                status=models.OrderItemStatus.ready,
            )
        )
        self.session.commit()
        report = self.client.get(
            "/location-analytics/summary",
            headers=_headers(self.owner),
        )
        self.assertEqual(report.status_code, 200, report.text)
        self.assertEqual(report.json()["combined"]["gross_sales_cents"], 2400)
        self.assertEqual(
            sum(row["gross_sales_cents"] for row in report.json()["by_location"]),
            report.json()["combined"]["gross_sales_cents"],
        )

    def test_label_generation(self) -> None:
        room = models.Table(
            tenant_id=self.tenant.id,
            location_id=self.default_location.id,
            name="Room 101A",
            display_number="101A",
            service_point_type="room",
        )
        table = models.Table(
            tenant_id=self.tenant.id,
            location_id=self.default_location.id,
            name="T4",
            display_number="4",
            service_point_type="table",
        )
        self.assertEqual(service_point_label(room), "Room 101A")
        self.assertEqual(service_point_label(table), "Table 4")

    def test_hours_override_midnight_and_date_range_exception(self) -> None:
        lounge = self._create_location("Late Lounge", "Late Lounge", "lounge")
        location = self.session.get(models.TenantLocation, lounge["id"])
        friday_schedule = {
            day: ({"open": "14:00", "close": "00:00"} if day == "friday" else {"closed": True})
            for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
        }
        saved = self.client.put(
            f"/locations/{location.id}/hours",
            headers=_headers(self.owner),
            json={
                "mode": "override",
                "opening_hours_override": friday_schedule,
                "ordering_hours_override": friday_schedule,
                "date_overrides": [],
            },
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.session.refresh(location)
        london = ZoneInfo("Europe/London")
        open_result = ordering_availability(
            self.session,
            self.tenant,
            location=location,
            now=datetime(2026, 8, 28, 23, 30, tzinfo=london),
        )
        self.assertTrue(open_result["allowed"], open_result)
        midnight_result = ordering_availability(
            self.session,
            self.tenant,
            location=location,
            now=datetime(2026, 8, 29, 0, 0, tzinfo=london),
        )
        self.assertFalse(midnight_result["allowed"])

        closed_range = self.client.put(
            f"/locations/{location.id}/hours",
            headers=_headers(self.owner),
            json={
                "mode": "override",
                "opening_hours_override": friday_schedule,
                "ordering_hours_override": friday_schedule,
                "date_overrides": [
                    {"date_from": "2026-08-28", "date_to": "2026-08-29", "is_closed": True}
                ],
            },
        )
        self.assertEqual(closed_range.status_code, 200, closed_range.text)
        self.assertEqual(len(closed_range.json()["date_overrides"]), 2)
        self.session.refresh(location)
        exception_result = ordering_availability(
            self.session,
            self.tenant,
            location=location,
            now=datetime(2026, 8, 28, 20, 0, tzinfo=london),
        )
        self.assertEqual(exception_result["code"], "LOCATION_CLOSED")

    def test_active_point_allowance_ignores_drafts_and_platform_can_oversee(self) -> None:
        self.tenant.saas_included_tables = 1
        self.session.add(self.tenant)
        self.session.commit()
        location_id = self.default_location.id
        first = self._create_point(location_id, "1", "table")
        draft = self.client.post(
            f"/locations/{location_id}/ordering-points",
            headers=_headers(self.owner),
            json={"display_number": "2", "service_point_type": "table", "is_ordering_enabled": False},
        )
        self.assertEqual(draft.status_code, 201, draft.text)
        blocked = self.client.patch(
            f"/locations/{location_id}/ordering-points/{draft.json()['id']}",
            headers=_headers(self.owner),
            json={"is_ordering_enabled": True},
        )
        self.assertEqual(blocked.status_code, 402, blocked.text)
        self.assertEqual(blocked.json()["detail"]["code"], "ordering_point_plan_limit")
        self.assertTrue(first["is_ordering_enabled"])

        operator = models.User(
            email=f"platform-location-{uuid.uuid4().hex[:8]}@amvara.de",
            hashed_password=security.get_password_hash("platform-location-password"),
            role=models.UserRole.platform_operator,
            tenant_id=None,
        )
        self.session.add(operator)
        self.session.commit()
        self.session.refresh(operator)
        platform_list = self.client.get(
            f"/platform/tenants/{self.tenant.id}/locations",
            headers=_headers(operator),
        )
        self.assertEqual(platform_list.status_code, 200, platform_list.text)
        self.assertEqual(platform_list.json()[0]["active_ordering_point_count"], 1)
        forbidden = self.client.get(
            f"/platform/tenants/{self.tenant.id}/locations",
            headers=_headers(self.owner),
        )
        self.assertEqual(forbidden.status_code, 403)

    def test_four_origins_share_fifo_kitchen_and_location_filter(self) -> None:
        station = models.KitchenStation(
            tenant_id=self.tenant.id,
            name="Pilot main kitchen",
            display_route="kitchen",
        )
        self.session.add(station)
        self.session.commit()
        self.session.refresh(station)
        self.tenant.default_kitchen_station_id = station.id
        self.session.add(self.tenant)
        origins = [
            (self.default_location, "table", "4"),
            (self._create_location("Sports", "Sports Lounge", "lounge"), "table", "7"),
            (self._create_location("Premium", "Blaby Hotel - Premium Building", "hotel_building"), "room", "212"),
            (self._create_location("Main", "Blaby Hotel - Main Building", "hotel_building"), "room", "104"),
        ]
        release_base = datetime.now(timezone.utc) - timedelta(minutes=8)
        expected_labels: list[str] = []
        expected_ids: list[int] = []
        for index, (raw_location, point_type, number) in enumerate(origins):
            location_id = raw_location.id if isinstance(raw_location, models.TenantLocation) else raw_location["id"]
            point = self._create_point(location_id, number, point_type)
            location = self.session.get(models.TenantLocation, location_id)
            order = models.Order(
                tenant_id=self.tenant.id,
                table_id=point["id"],
                location_id=location_id,
                location_name_snapshot=location.display_name,
                service_point_type_snapshot=point_type,
                service_point_label_snapshot=("Room " if point_type == "room" else "Table ") + number,
                kitchen_station_id_snapshot=station.id,
                payment_account_snapshot="tenant-default",
                status=models.OrderStatus.paid,
                paid_at=release_base + timedelta(minutes=index),
                kitchen_released_at=release_base + timedelta(minutes=index),
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
                    status=models.OrderItemStatus.pending,
                )
            )
            expected_ids.append(order.id)
            expected_labels.append(order.service_point_label_snapshot)
        self.session.commit()
        response = self.client.get(
            "/orders?kitchen_released_only=true", headers=_headers(self.owner)
        )
        self.assertEqual(response.status_code, 200, response.text)
        pilot_rows = [row for row in response.json() if row["id"] in expected_ids]
        fifo = sorted(pilot_rows, key=lambda row: row["kitchen_released_at"])
        self.assertEqual([row["service_point_label"] for row in fifo], expected_labels)
        self.assertEqual({row["location_name"] for row in fifo}, {
            self.default_location.display_name,
            "Sports Lounge",
            "Blaby Hotel - Premium Building",
            "Blaby Hotel - Main Building",
        })
