"""POS tip presets and mark-paid tip amount (GitHub #58)."""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from pg_client_mixin import PgClientTestCase
from sqlmodel import select

from app import models, security, order_payment_service as order_pay_svc
from app.main import (
    _allowed_tip_presets,
    _resolve_tip_for_mark_paid,
    _resolve_tip_on_mark_paid,
)
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


class TestOrderTip(PgClientTestCase):
    def setUp(self):
        super().setUp()
        self.tenant = models.Tenant(
            name="Tip Test",
            tip_preset_percents=[10, 20],
            tip_tax_rate_percent=10,
        )
        self.session.add(self.tenant)
        self.session.commit()
        self.session.refresh(self.tenant)

        self.user = models.User(
            email="tip-owner@test.local",
            hashed_password=get_password_hash("secret"),
            role=models.UserRole.owner,
            tenant_id=self.tenant.id,
        )
        self.session.add(self.user)
        self.session.commit()

        floor = models.Floor(name="Main", tenant_id=self.tenant.id)
        self.session.add(floor)
        self.session.commit()
        self.session.refresh(floor)

        self.table = models.Table(
            name="T1",
            tenant_id=self.tenant.id,
            floor_id=floor.id,
            is_active=True,
        )
        self.session.add(self.table)
        self.session.commit()
        self.session.refresh(self.table)

        self.product = models.Product(
            name="Coffee",
            price_cents=1000,
            tenant_id=self.tenant.id,
        )
        self.session.add(self.product)
        self.session.commit()
        self.session.refresh(self.product)

        self.order = models.Order(
            table_id=self.table.id,
            tenant_id=self.tenant.id,
            status=models.OrderStatus.pending,
        )
        self.session.add(self.order)
        self.session.commit()
        self.session.refresh(self.order)

        item = models.OrderItem(
            order_id=self.order.id,
            product_id=self.product.id,
            product_name=self.product.name,
            quantity=1,
            price_cents=1000,
            status=models.OrderItemStatus.pending,
        )
        self.session.add(item)
        self.session.commit()

    def test_cash_settlement_releases_prepayment_to_kitchen(self):
        self.order.requires_prepayment = True
        self.session.add(self.order)
        self.session.commit()
        headers = _bearer_headers(self.user)
        before = self.client.get('/orders/kitchen-feed', headers=headers)
        self.assertEqual(before.status_code, 200)
        self.assertNotIn(self.order.id, [o['id'] for o in before.json()])
        response = self.client.put(f'/orders/{self.order.id}/mark-paid', headers=headers,
                                   json={'payment_method': 'cash', 'tip_percent': 0})
        self.assertEqual(response.status_code, 200, response.text)
        self.session.refresh(self.order)
        released = self.order.kitchen_released_at
        self.assertIsNotNone(released)
        self.assertEqual(released, self.order.paid_at)
        after = self.client.get('/orders/kitchen-feed', headers=headers)
        self.assertEqual(after.status_code, 200)
        self.assertIn(self.order.id, [o['id'] for o in after.json()])
        replay = self.client.put(f'/orders/{self.order.id}/mark-paid', headers=headers,
                                 json={'payment_method': 'cash', 'tip_percent': 0})
        self.assertEqual(replay.status_code, 400)
        self.session.refresh(self.order)
        self.assertEqual(self.order.kitchen_released_at, released)

    def test_partial_cash_releases_only_when_balance_is_covered(self):
        self.order.requires_prepayment = True
        self.session.add(self.order)
        self.session.commit()
        headers = _bearer_headers(self.user)
        path = f'/orders/{self.order.id}/payments'
        partial = self.client.post(path, headers=headers,
                                   json={'payment_method': 'cash', 'amount_cents': 400})
        self.assertEqual(partial.status_code, 200, partial.text)
        self.session.refresh(self.order)
        self.assertIsNone(self.order.paid_at)
        self.assertIsNone(self.order.kitchen_released_at)
        final = self.client.post(path, headers=headers,
                                 json={'payment_method': 'cash', 'amount_cents': 600})
        self.assertEqual(final.status_code, 200, final.text)
        self.session.refresh(self.order)
        self.assertIsNotNone(self.order.kitchen_released_at)
        self.assertEqual(self.order.kitchen_released_at, self.order.paid_at)

    def test_discount_covered_prepayment_releases_without_new_leg(self):
        self.order.requires_prepayment = True
        self.order.loyalty_discount_cents = 1000
        self.session.add(self.order)
        self.session.commit()
        response = self.client.put(f'/orders/{self.order.id}/mark-paid',
            headers=_bearer_headers(self.user), json={'payment_method': 'cash', 'tip_percent': 0})
        self.assertEqual(response.status_code, 200, response.text)
        self.session.refresh(self.order)
        self.assertIsNotNone(self.order.kitchen_released_at)
        self.assertEqual(response.json()['amount_remaining_cents'], 0)
        self.assertEqual(response.json()['payments'], [])

    def test_release_helper_preserves_safety_boundaries(self):
        now = datetime.now(timezone.utc)
        for state, status, paid_at in [
            ('refunded', models.OrderStatus.paid, now),
            ('pending', models.OrderStatus.cancelled, now),
            ('pending', models.OrderStatus.pending, None),
        ]:
            with self.subTest(state=state, status=status):
                order = models.Order(tenant_id=self.tenant.id, requires_prepayment=True,
                                    payment_state=state, status=status, paid_at=paid_at)
                order_pay_svc.release_paid_prepayment_order(order)
                self.assertIsNone(order.kitchen_released_at)
        order = models.Order(tenant_id=self.tenant.id, requires_prepayment=True,
                            paid_at=now, kitchen_released_at=now - timedelta(minutes=1))
        original = order.kitchen_released_at
        order_pay_svc.release_paid_prepayment_order(order)
        self.assertEqual(order.kitchen_released_at, original)

    def test_allowed_presets_from_tenant(self):
        self.assertEqual(_allowed_tip_presets(self.tenant), [10, 20])

    def test_resolve_tip_ten_percent(self):
        pct, amt = _resolve_tip_on_mark_paid(
            self.session, self.tenant, self.order.id, 10
        )
        self.assertEqual(pct, 10)
        self.assertEqual(amt, 100)

    def test_resolve_no_tip(self):
        pct, amt = _resolve_tip_on_mark_paid(
            self.session, self.tenant, self.order.id, None
        )
        self.assertIsNone(pct)
        self.assertEqual(amt, 0)

    def test_resolve_explicit_zero_percent(self):
        pct, amt = _resolve_tip_on_mark_paid(
            self.session, self.tenant, self.order.id, 0
        )
        self.assertIsNone(pct)
        self.assertEqual(amt, 0)

    def test_tip_amount_rounds_half_up(self):
        from sqlmodel import select

        item = self.session.exec(
            select(models.OrderItem).where(models.OrderItem.order_id == self.order.id)
        ).first()
        item.price_cents = 335
        item.quantity = 1
        self.session.add(item)
        self.session.commit()
        # (335 * 10 + 50) // 100 = 34
        pct, amt = _resolve_tip_on_mark_paid(
            self.session, self.tenant, self.order.id, 10
        )
        self.assertEqual(pct, 10)
        self.assertEqual(amt, 34)

    def test_reject_tip_when_order_subtotal_zero(self):
        empty = models.Order(
            table_id=self.table.id,
            tenant_id=self.tenant.id,
            status=models.OrderStatus.pending,
        )
        self.session.add(empty)
        self.session.commit()
        self.session.refresh(empty)
        with self.assertRaises(HTTPException) as ctx:
            _resolve_tip_on_mark_paid(
                self.session, self.tenant, empty.id, 10
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_reject_percent_not_in_presets(self):
        with self.assertRaises(HTTPException) as ctx:
            _resolve_tip_on_mark_paid(
                self.session, self.tenant, self.order.id, 15
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_legacy_null_presets_default(self):
        t = models.Tenant(name="Legacy")
        self.session.add(t)
        self.session.commit()
        self.session.refresh(t)
        self.assertEqual(_allowed_tip_presets(t), [5, 10, 15, 20])

    def test_empty_presets_disable_tips(self):
        t = models.Tenant(name="No tips", tip_preset_percents=[])
        self.session.add(t)
        self.session.commit()
        self.session.refresh(t)
        self.assertEqual(_allowed_tip_presets(t), [])
        with self.assertRaises(HTTPException) as ctx:
            _resolve_tip_on_mark_paid(self.session, t, self.order.id, 10)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_resolve_mark_paid_overpayment_mode(self) -> None:
        self.tenant.tip_entry_mode = "overpayment"
        self.session.add(self.tenant)
        self.session.commit()
        pdata = models.OrderMarkPaid(
            payment_method="terminal",
            tip_percent=None,
            tip_amount_cents=150,
            amount_paid_cents=1000 + 150,
        )
        pct, amt = _resolve_tip_for_mark_paid(
            self.session, self.tenant, self.order.id, pdata
        )
        self.assertIsNone(pct)
        self.assertEqual(amt, 150)

    def test_preset_mode_rejects_tip_amount_cents_body(self) -> None:
        pdata = models.OrderMarkPaid(
            payment_method="cash",
            tip_percent=None,
            tip_amount_cents=10,
        )
        with self.assertRaises(HTTPException) as ctx:
            _resolve_tip_for_mark_paid(
                self.session, self.tenant, self.order.id, pdata
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_overpayment_requires_tip_amount_cents(self) -> None:
        self.tenant.tip_entry_mode = "overpayment"
        self.session.add(self.tenant)
        self.session.commit()
        pdata = models.OrderMarkPaid(payment_method="cash", tip_percent=None)
        with self.assertRaises(HTTPException) as ctx:
            _resolve_tip_for_mark_paid(
                self.session, self.tenant, self.order.id, pdata
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_overpayment_rejects_amount_paid_below_subtotal_plus_tip(self) -> None:
        self.tenant.tip_entry_mode = "overpayment"
        self.session.add(self.tenant)
        self.session.commit()
        pdata = models.OrderMarkPaid(
            payment_method="terminal",
            tip_amount_cents=150,
            amount_paid_cents=1000 + 149,
        )
        with self.assertRaises(HTTPException) as ctx:
            _resolve_tip_for_mark_paid(
                self.session, self.tenant, self.order.id, pdata
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_api_mark_paid_overpayment_sets_tip_and_waiter(self) -> None:
        self.tenant.tip_entry_mode = "overpayment"
        self.session.add(self.tenant)
        self.session.commit()
        waiter = models.User(
            email="tip-waiter@test.local",
            hashed_password=get_password_hash("secret"),
            role=models.UserRole.waiter,
            tenant_id=self.tenant.id,
        )
        self.session.add(waiter)
        self.session.commit()
        self.session.refresh(waiter)
        self.table.assigned_waiter_id = waiter.id
        self.session.add(self.table)
        self.session.commit()

        h = _bearer_headers(self.user)
        r = self.client.put(
            f"/orders/{self.order.id}/mark-paid",
            json={
                "payment_method": "terminal",
                "tip_amount_cents": 200,
                "amount_paid_cents": 1000 + 200,
            },
            headers=h,
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body.get("tip_amount_cents"), 200)
        order = self.session.get(models.Order, self.order.id)
        assert order is not None
        self.assertEqual(order.tip_amount_cents, 200)
        self.assertEqual(order.tip_attributed_user_id, waiter.id)

    def _overpayment_fixture(
        self, *, basket=500, discount=200, fee=0, existing_tip=0, prior=0, voided=0,
    ):
        self.tenant.tip_entry_mode = "overpayment"
        self.session.add(self.tenant)
        order = models.Order(
            tenant_id=self.tenant.id,
            table_id=None if fee else self.table.id,
            order_channel=(models.OrderChannel.satisfecho_delivery if fee else models.OrderChannel.table),
            status=models.OrderStatus.pending,
            delivery_fee_cents=fee,
            loyalty_discount_cents=discount,
            tip_amount_cents=existing_tip or None,
        )
        self.session.add(order)
        self.session.flush()
        self.session.add(models.OrderItem(
            order_id=order.id, product_id=self.product.id,
            product_name=self.product.name, quantity=1, price_cents=basket,
            status=models.OrderItemStatus.pending,
        ))
        for amount, is_voided in ((prior, False), (voided, True)):
            if amount:
                self.session.add(models.OrderPayment(
                    tenant_id=self.tenant.id, order_id=order.id,
                    amount_cents=amount, payment_method="cash",
                    voided_at=datetime.now(timezone.utc) if is_voided else None,
                ))
        self.session.commit()
        self.session.refresh(order)
        return order

    def test_overpayment_new_tender_uses_canonical_net_balance(self):
        cases = [
            ("discount", {}, 0, 300),
            ("delivery_fee_and_tip", {"fee": 100}, 50, 450),
            ("prior_payment", {"fee": 100, "prior": 100}, 50, 350),
            ("capped_discount_keeps_tip", {"basket": 100}, 50, 50),
            ("voided_payment_not_credit", {"voided": 100}, 0, 300),
            ("active_and_voided", {"prior": 100, "voided": 100}, 0, 200),
            ("selected_tip_replaces_old_tip", {"existing_tip": 70, "prior": 100}, 20, 220),
            ("discount_covers_remaining", {"prior": 350}, 0, 0),
        ]
        for name, options, tip, required in cases:
            with self.subTest(case=name):
                order = self._overpayment_fixture(**options)
                before = order.model_dump()
                for supplied in (required, required + 10):
                    self.assertEqual(
                        _resolve_tip_for_mark_paid(
                            self.session, self.tenant, order.id,
                            models.OrderMarkPaid(payment_method="cash", tip_amount_cents=tip,
                                                 amount_paid_cents=supplied),
                        ), (None, tip),
                    )
                with self.assertRaises(HTTPException) as rejected:
                    _resolve_tip_for_mark_paid(
                        self.session, self.tenant, order.id,
                        models.OrderMarkPaid(payment_method="cash", tip_amount_cents=tip,
                                             amount_paid_cents=required - 1),
                    )
                self.assertEqual(rejected.exception.status_code, 400)
                self.assertEqual(order.model_dump(), before)

    def test_overpayment_optional_new_tender_and_tip_safeguards(self):
        order = self._overpayment_fixture()
        self.assertEqual(_resolve_tip_for_mark_paid(
            self.session, self.tenant, order.id,
            models.OrderMarkPaid(payment_method="cash", tip_amount_cents=0),
        ), (None, 0))
        for tip in (-1, 100_000_001):
            with self.subTest(tip=tip), self.assertRaises(HTTPException) as rejected:
                _resolve_tip_for_mark_paid(
                    self.session, self.tenant, order.id,
                    models.OrderMarkPaid(payment_method="cash", tip_amount_cents=tip,
                                         amount_paid_cents=200_000_000),
                )
            self.assertEqual(rejected.exception.status_code, 400)

    def test_overpayment_empty_or_inactive_basket_cannot_receive_tip(self):
        for inactive in (None, "removed_by_customer", "removed_by_user_id", "cancelled"):
            with self.subTest(inactive=inactive):
                order = self._overpayment_fixture(basket=0 if inactive is None else 500)
                item = self.session.exec(select(models.OrderItem).where(
                    models.OrderItem.order_id == order.id,
                )).one()
                if inactive == "cancelled":
                    item.status = models.OrderItemStatus.cancelled
                elif inactive == "removed_by_customer":
                    item.removed_by_customer = True
                elif inactive == "removed_by_user_id":
                    item.removed_by_user_id = self.user.id
                self.session.add(item)
                self.session.commit()
                with self.assertRaises(HTTPException) as rejected:
                    _resolve_tip_for_mark_paid(
                        self.session, self.tenant, order.id,
                        models.OrderMarkPaid(payment_method="cash", tip_amount_cents=50,
                                             amount_paid_cents=50),
                    )
                self.assertEqual(rejected.exception.status_code, 400)

    def test_overpayment_missing_foreign_and_deleted_order_rejected(self):
        order = self._overpayment_fixture()
        other = models.Tenant(name="Other tip tenant")
        self.session.add(other)
        self.session.flush()
        foreign = models.Order(tenant_id=other.id)
        self.session.add(foreign)
        order.deleted_at = datetime.now(timezone.utc)
        self.session.add(order)
        self.session.commit()
        for order_id in (-1, foreign.id, order.id):
            with self.subTest(order_id=order_id), self.assertRaises(HTTPException) as rejected:
                _resolve_tip_for_mark_paid(
                    self.session, self.tenant, order_id,
                    models.OrderMarkPaid(payment_method="cash", tip_amount_cents=0,
                                         amount_paid_cents=0),
                )
            self.assertEqual(rejected.exception.status_code, 404)

    def test_overpayment_mark_paid_and_finish_record_only_new_tender(self):
        scenarios = [
            ({}, 0, 300),
            ({"fee": 100, "prior": 100, "voided": 75, "existing_tip": 80}, 50, 350),
            ({"basket": 100}, 50, 50),
        ]
        headers = _bearer_headers(self.user)
        for endpoint in ("mark-paid", "finish"):
            for options, tip, new_tender in scenarios:
                with self.subTest(endpoint=endpoint, options=options):
                    order = self._overpayment_fixture(**options)
                    path = f"/orders/{order.id}/{endpoint}"
                    rejected = self.client.put(path, headers=headers, json={
                        "payment_method": "cash", "tip_amount_cents": tip,
                        "amount_paid_cents": new_tender - 1,
                    })
                    self.assertEqual(rejected.status_code, 400, rejected.text)
                    self.session.refresh(order)
                    self.assertIsNone(order.paid_at)
                    item = self.session.exec(select(models.OrderItem).where(
                        models.OrderItem.order_id == order.id,
                    )).one()
                    self.session.refresh(item)
                    self.assertEqual(item.status, models.OrderItemStatus.pending)

                    accepted = self.client.put(path, headers=headers, json={
                        "payment_method": "cash", "tip_amount_cents": tip,
                        "amount_paid_cents": new_tender,
                    })
                    self.assertEqual(accepted.status_code, 200, accepted.text)
                    summary = self.client.get(f"/orders/{order.id}/payments", headers=headers)
                    self.assertEqual(summary.status_code, 200, summary.text)
                    self.assertEqual(summary.json()["amount_before_tip_cents"],
                                     max(0, options.get("basket", 500) + options.get("fee", 0) - 200))
                    self.session.refresh(order)
                    self.assertIsNotNone(order.paid_at)
                    self.assertEqual(order.tip_amount_cents or 0, tip)
                    self.assertEqual(order.loyalty_discount_cents, 200)
                    self.assertEqual(order.delivery_fee_cents, options.get("fee", 0))
                    payments = self.session.exec(select(models.OrderPayment).where(
                        models.OrderPayment.order_id == order.id,
                        models.OrderPayment.voided_at.is_(None),
                    )).all()
                    self.assertEqual(sum(p.amount_cents for p in payments),
                                     options.get("prior", 0) + new_tender)
                    self.assertEqual(len(payments), 1 + bool(options.get("prior")))
                    self.assertEqual(payments[-1].amount_cents, new_tender)
                    self.session.refresh(item)
                    self.assertEqual(item.status, models.OrderItemStatus.delivered
                                     if endpoint == "finish" else models.OrderItemStatus.pending)
                    duplicate = self.client.put(path, headers=headers, json={
                        "payment_method": "cash", "tip_amount_cents": tip,
                        "amount_paid_cents": new_tender,
                    })
                    self.assertEqual(duplicate.status_code, 400)

    def test_overpayment_api_rejects_foreign_tenant(self):
        order = self._overpayment_fixture()
        other = models.Tenant(name="Foreign cash tenant")
        self.session.add(other)
        self.session.flush()
        outsider = models.User(
            tenant_id=other.id, email="tip-foreign@test.local",
            hashed_password=self.user.hashed_password, role=models.UserRole.owner,
        )
        self.session.add(outsider)
        self.session.commit()
        for endpoint in ("mark-paid", "finish"):
            response = self.client.put(
                f"/orders/{order.id}/{endpoint}", headers=_bearer_headers(outsider),
                json={"payment_method": "cash", "tip_amount_cents": 0, "amount_paid_cents": 300},
            )
            self.assertEqual(response.status_code, 404)
        self.session.refresh(order)
        self.assertIsNone(order.paid_at)


if __name__ == "__main__":
    unittest.main()
