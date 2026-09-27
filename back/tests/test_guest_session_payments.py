"""No network: per-browser Stripe checkout and existing line ledger integration."""
from unittest.mock import patch

import stripe
from sqlmodel import select

from pg_client_mixin import PgClientTestCase
from app import models, guest_payment_service as guest, order_payment_service as payments


class TestGuestSessionPayments(PgClientTestCase):
    def setUp(self):
        super().setUp()
        self.tenant = models.Tenant(name="Scoped checkout", stripe_secret_key="sk_test_fixture", currency_code="GBP")
        self.session.add(self.tenant)
        self.session.flush()
        self.table = models.Table(name="Shared", tenant_id=self.tenant.id)
        self.product = models.Product(name="Dish", tenant_id=self.tenant.id, price_cents=500)
        self.session.add_all([self.table, self.product])
        self.session.flush()
        self.order = models.Order(tenant_id=self.tenant.id, table_id=self.table.id,
                                  ordering_point_assignment_version_snapshot=1)
        self.session.add(self.order)
        self.session.flush()
        self.items = []
        for sid, amount in [("browser-one", 500), ("browser-two", 700)]:
            item = models.OrderItem(order_id=self.order.id, product_id=self.product.id,
                product_name="Dish", price_cents=amount, quantity=1, added_by_session=sid)
            self.items.append(item)
            self.session.add(item)
        self.session.commit()
        self.intents = {}
        self.create_mock = patch("stripe.PaymentIntent.create", side_effect=self.provider_create).start()
        self.retrieve_mock = patch("stripe.PaymentIntent.retrieve", side_effect=lambda key, **kw: self.intents[key]).start()
        self.addCleanup(patch.stopall)

    def provider_create(self, **kw):
        key = "pi_" + kw["metadata"]["guest_payment_attempt_id"]
        if key not in self.intents:
            self.intents[key] = stripe.StripeObject.construct_from({
                "id": key, "client_secret": key + "_secret", "status": "requires_payment_method",
                "amount": kw["amount"], "amount_received": 0, "currency": kw["currency"],
                "metadata": kw["metadata"],
            }, None)
        return self.intents[key]

    def start(self, sid):
        return self.client.post(f"/orders/{self.order.id}/create-payment-intent",
            params={"table_token": self.table.token, "session_id": sid})

    def confirm(self, sid, key):
        intent = self.intents[key]
        intent["status"] = "succeeded"
        intent["amount_received"] = intent["amount"]
        return self.client.post(f"/orders/{self.order.id}/confirm-payment", params={
            "table_token": self.table.token, "session_id": sid, "payment_intent_id": key})

    def test_two_guests_amounts_and_idempotent_partial_then_full_settlement(self):
        first = self.start("browser-one")
        self.assertEqual(first.status_code, 200, first.text)
        second = self.start("browser-two")
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()["amount"], 500)
        self.assertEqual(second.json()["amount"], 700)
        a, b = first.json()["payment_intent_id"], second.json()["payment_intent_id"]
        self.assertNotEqual(a, b)
        paid = self.confirm("browser-one", a)
        self.assertEqual(paid.status_code, 200, paid.text)
        self.assertFalse(paid.json()["order_fully_paid"])
        self.assertEqual(self.confirm("browser-one", a).status_code, 200)
        self.session.expire_all()
        self.assertEqual(len(payments.list_active_payments(self.session, self.order.id)), 1)
        self.assertEqual(payments.allocated_order_item_ids(self.session, self.order.id), {self.items[0].id})
        view = self.client.get(f"/menu/{self.table.token}/order", params={"session_id": "browser-one"}).json()["order"]
        self.assertEqual(view["amount_remaining_cents"], 0)
        self.assertTrue(view["items"][0]["is_paid"])
        self.assertFalse(view["can_pay"])
        paid2 = self.confirm("browser-two", b)
        self.assertEqual(paid2.status_code, 200, paid2.text)
        self.assertTrue(paid2.json()["order_fully_paid"])
        self.session.expire_all()
        self.assertIsNone(self.session.get(models.Order, self.order.id).stripe_payment_intent_id)
        self.assertEqual(len(payments.list_active_payments(self.session, self.order.id)), 2)

    def test_foreign_session_cannot_create_or_confirm_another_selection(self):
        self.assertEqual(self.start("foreign-browser").status_code, 403)
        self.assertEqual(self.start("").status_code, 403)
        created = self.start("browser-one").json()
        self.assertEqual(self.confirm("browser-two", created["payment_intent_id"]).status_code, 403)

    def test_shared_prepayment_is_blocked_without_provider_call(self):
        self.order.requires_prepayment = True
        self.session.commit()
        r = self.start("browser-one")
        self.assertEqual(r.status_code, 409, r.text)
        self.create_mock.assert_not_called()
        self.assertIsNone(self.order.kitchen_released_at)

    def test_repeat_creation_reuses_intent(self):
        first = self.start("browser-one").json()
        second = self.start("browser-one").json()
        self.assertEqual(first["payment_intent_id"], second["payment_intent_id"])
        self.assertEqual(self.create_mock.call_count, 1)

    def test_webhook_settles_and_retries_without_browser(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        obj = self.intents[key]
        obj["status"] = "succeeded"
        obj["amount_received"] = obj["amount"]
        for _ in range(2):
            self.assertTrue(guest.webhook(self.session, self.tenant.id, "payment_intent.succeeded", obj)["handled"])
        self.assertEqual(len(payments.list_active_payments(self.session, self.order.id)), 1)

    def test_refund_preserves_other_leg_and_prevents_recharge(self):
        a = self.start("browser-one").json()["payment_intent_id"]
        b = self.start("browser-two").json()["payment_intent_id"]
        self.assertEqual(self.confirm("browser-one", a).status_code, 200)
        self.assertEqual(self.confirm("browser-two", b).status_code, 200)
        refund = {"payment_intent": a, "amount_refunded": 100, "amount": 500, "currency": "gbp"}
        for _ in range(2):
            guest.webhook(self.session, self.tenant.id, "charge.refunded", refund)
        self.assertEqual(len(payments.list_active_payments(self.session, self.order.id)), 2)
        self.session.expire_all()
        refunded_order = self.session.get(models.Order, self.order.id)
        self.assertEqual(refunded_order.refunded_amount_cents, 100)
        self.assertTrue(refunded_order.flagged_for_review)
        self.assertEqual(refunded_order.payment_state, "requires_staff_reconciliation")
        other_attempt = self.session.exec(select(models.GuestPaymentAttempt).where(
            models.GuestPaymentAttempt.stripe_payment_intent_id == b)).one()
        self.assertEqual(other_attempt.state, "succeeded")
        self.assertEqual(other_attempt.refunded_amount_cents, 0)
        own_view = self.client.get(f"/menu/{self.table.token}/order",
            params={"session_id": "browser-one"}).json()["order"]
        self.assertEqual(own_view["customer_payment_state"], "refunded")
        self.assertEqual(own_view["customer_refunded_cents"], 100)
        self.assertFalse(own_view["can_pay"])
        other_view = self.client.get(f"/menu/{self.table.token}/order",
            params={"session_id": "browser-two"}).json()["order"]
        self.assertEqual(other_view["customer_payment_state"], "paid")
        self.assertEqual(self.start("browser-one").status_code, 409)

    def test_foreign_item_edit_and_whole_shared_cancel_rejected(self):
        url = f"/menu/{self.table.token}/order/{self.order.id}"
        r = self.client.put(url + f"/items/{self.items[1].id}", params={"session_id": "browser-one"}, json={"quantity": 2})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.delete(url, params={"session_id": "browser-one"})
        self.assertEqual(r.status_code, 403, r.text)

    def test_pending_attempt_blocks_customer_mutations_and_staff_ledger(self):
        self.assertEqual(self.start("browser-one").status_code, 200)
        r = self.client.delete(f"/menu/{self.table.token}/order/{self.order.id}/items/{self.items[0].id}",
                              params={"session_id": "browser-one"})
        self.assertEqual(r.status_code, 409, r.text)
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as caught:
            payments.record_payment(self.session, order=self.order, amount_cents=500,
                                    payment_method="cash", paid_by_user_id=None)
        self.assertEqual(caught.exception.status_code, 409)
        self.session.rollback()

    def webhook_route(self, obj, event_type="payment_intent.succeeded", **event_fields):
        event = {"type": event_type, "data": {"object": obj}, **event_fields}
        with patch("app.main.tenant_stripe_webhook_secret", return_value="whsec_fixture"), \
                patch("stripe.Webhook.construct_event", return_value=event) as verify:
            response = self.client.post(f"/payments/stripe/webhook/{self.tenant.id}",
                content=b"signed-fixture", headers={"stripe-signature": "fixture-signature"})
            verify.assert_called_once_with(b"signed-fixture", "fixture-signature", "whsec_fixture")
            return response

    def test_signed_webhook_route_dispatches_each_guest_not_order_intent(self):
        for sid in ("browser-one", "browser-two"):
            key = self.start(sid).json()["payment_intent_id"]
            obj = self.intents[key]
            obj["status"] = "succeeded"
            obj["amount_received"] = obj["amount"]
            for _ in range(2):
                response = self.webhook_route(obj)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["handled"])
        self.session.expire_all()
        self.assertEqual(len(payments.list_active_payments(self.session, self.order.id)), 2)

    def test_webhook_rejects_missing_or_invalid_signature(self):
        with patch("app.main.tenant_stripe_webhook_secret", return_value="whsec_fixture"):
            url = f"/payments/stripe/webhook/{self.tenant.id}"
            self.assertEqual(self.client.post(url, content=b"fixture").status_code, 400)
            with patch("stripe.Webhook.construct_event", side_effect=ValueError("Invalid signature")):
                self.assertEqual(self.client.post(url, content=b"fixture",
                    headers={"stripe-signature": "bad"}).status_code, 400)

    def test_wrong_amount_tenant_and_account_binding_cannot_settle(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        obj = self.intents[key]
        obj["status"] = "succeeded"
        obj["amount_received"] = obj["amount"]
        obj["amount"] = 1
        self.assertEqual(self.webhook_route(obj).status_code, 400)
        obj["amount"] = 500
        obj["metadata"]["tenant_id"] = "999999"
        self.assertEqual(self.webhook_route(obj).status_code, 400)
        obj["metadata"]["tenant_id"] = str(self.tenant.id)
        obj["metadata"]["payment_account_snapshot"] = "acct_foreign"
        self.assertEqual(self.webhook_route(obj).status_code, 400)
        self.assertEqual(payments.list_active_payments(self.session, self.order.id), [])

    def test_connect_webhook_rejects_foreign_event_account(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        self.tenant.stripe_payment_mode = "connect"
        self.tenant.stripe_connected_account_id = "acct_expected"
        self.session.commit()
        with patch("app.main.settings.stripe_guest_webhook_secret", "whsec_fixture"):
            response = self.webhook_route(self.intents[key], account="acct_wrong")
        self.assertEqual(response.status_code, 400, response.text)

    def test_provider_timeout_retries_durable_same_idempotency_key(self):
        seen = []
        def uncertain_create(**kwargs):
            seen.append(kwargs["idempotency_key"])
            result = self.provider_create(**kwargs)
            if len(seen) == 1:
                raise stripe.error.APIConnectionError("simulated unknown provider result")
            return result
        self.create_mock.side_effect = uncertain_create
        try:
            response = self.start("browser-one")
            self.assertGreaterEqual(response.status_code, 400)
        except stripe.error.APIConnectionError:
            pass
        retry = self.start("browser-one")
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0], seen[1])
        self.assertEqual(len(self.intents), 1)

    def test_only_confirmed_cancellation_frees_reservation(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        obj = self.intents[key]
        obj["status"] = "requires_payment_method"
        self.assertEqual(self.webhook_route(obj, "payment_intent.payment_failed").status_code, 200)
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            guest.assert_no_pending(self.session, self.order)
        obj["status"] = "canceled"
        self.assertEqual(self.webhook_route(obj, "payment_intent.canceled").status_code, 200)
        guest.assert_no_pending(self.session, self.order)
        retry = self.start("browser-one")
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertNotEqual(key, retry.json()["payment_intent_id"])

    def test_staff_mark_paid_and_line_edit_block_pending_customer_capture(self):
        from app import security
        owner = models.User(email="guest-payment-owner@scanaki.uk", hashed_password="unused",
            tenant_id=self.tenant.id, role=models.UserRole.owner)
        self.session.add(owner)
        self.session.commit()
        token = security.create_access_token({"sub": owner.email, "tenant_id": self.tenant.id,
                                              "token_version": owner.token_version})
        headers = {"Authorization": f"Bearer {token}"}
        self.assertEqual(self.start("browser-one").status_code, 200)
        paid = self.client.put(f"/orders/{self.order.id}/mark-paid", headers=headers,
                               json={"payment_method": "cash"})
        self.assertEqual(paid.status_code, 409, paid.text)
        edit = self.client.put(f"/orders/{self.order.id}/items/{self.items[0].id}",
                               headers=headers, json={"quantity": 3})
        self.assertEqual(edit.status_code, 409, edit.text)

    def test_captured_guest_leg_cannot_be_voided_edited_or_replaced_by_revolut(self):
        from app import security
        owner = models.User(email="captured-guard-owner@scanaki.uk", hashed_password="unused",
            tenant_id=self.tenant.id, role=models.UserRole.owner)
        self.session.add(owner)
        self.session.commit()
        headers = {"Authorization": "Bearer " + security.create_access_token({
            "sub": owner.email, "tenant_id": self.tenant.id, "token_version": owner.token_version})}
        key = self.start("browser-one").json()["payment_intent_id"]
        result = self.confirm("browser-one", key)
        self.assertEqual(result.status_code, 200, result.text)
        self.session.expire_all()
        leg = payments.list_active_payments(self.session, self.order.id)[0]
        root = f"/orders/{self.order.id}"
        requests = [
            ("put", root + "/unmark-paid", {}),
            ("delete", root + f"/payments/{leg.id}", {}),
            ("put", root + f"/items/{self.items[0].id}", {"json": {"quantity": 2}}),
            ("delete", root + f"/items/{self.items[0].id}", {}),
        ]
        for method, path, kwargs in requests:
            response = getattr(self.client, method)(path, headers=headers, **kwargs)
            self.assertEqual(response.status_code, 409, f"{path}: {response.text}")
        with patch("app.main._revolut_create_order") as create, patch("app.main._revolut_retrieve_order") as retrieve:
            response = self.client.post(root + "/create-revolut-order", params={"table_token": self.table.token})
            self.assertEqual(response.status_code, 409, response.text)
            response = self.client.post(root + "/confirm-revolut-payment", params={
                "table_token": self.table.token, "revolut_order_id": "revolut-foreign"})
            self.assertEqual(response.status_code, 409, response.text)
            create.assert_not_called()
            retrieve.assert_not_called()
        remaining = self.start("browser-two")
        self.assertEqual(remaining.status_code, 200, remaining.text)
        self.assertEqual(remaining.json()["amount"], 700)
        done = self.confirm("browser-two", remaining.json()["payment_intent_id"])
        self.assertEqual(done.status_code, 200, done.text)
        self.assertTrue(done.json()["order_fully_paid"])

    def cancel_checkout(self, sid, key):
        return self.client.post(f"/orders/{self.order.id}/cancel-customer-payment", params={
            "table_token": self.table.token, "session_id": sid, "payment_intent_id": key})

    def test_customer_cancel_releases_only_after_provider_and_is_idempotent(self):
        created = self.start("browser-one")
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["payment_scope"], "session_items")
        key = created.json()["payment_intent_id"]
        def cancel(intent_id, **kwargs):
            self.intents[intent_id]["status"] = "canceled"
            return self.intents[intent_id]
        with patch("stripe.PaymentIntent.cancel", side_effect=cancel) as provider:
            result = self.cancel_checkout("browser-one", key)
            self.assertEqual(result.status_code, 200, result.text)
            provider.assert_called_once()
            repeated = self.cancel_checkout("browser-one", key)
            self.assertEqual(repeated.status_code, 200, repeated.text)
            self.assertEqual(provider.call_count, 1)
        guest.assert_no_pending(self.session, self.order)
        self.assertEqual(payments.list_active_payments(self.session, self.order.id), [])

    def test_foreign_browser_cannot_cancel_customer_intent(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        with patch("stripe.PaymentIntent.cancel") as provider:
            result = self.cancel_checkout("browser-two", key)
            self.assertEqual(result.status_code, 403, result.text)
            provider.assert_not_called()

    def test_cancel_capture_race_records_payment_without_voiding(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        self.intents[key]["status"] = "succeeded"
        self.intents[key]["amount_received"] = self.intents[key]["amount"]
        with patch("stripe.PaymentIntent.cancel", side_effect=stripe.error.InvalidRequestError(
                "Intent already succeeded", "payment_intent")):
            response = self.cancel_checkout("browser-one", key)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "paid")
        self.session.expire_all()
        legs = payments.list_active_payments(self.session, self.order.id)
        self.assertEqual(len(legs), 1)
        self.assertEqual(legs[0].amount_cents, 500)
        self.assertIsNone(legs[0].voided_at)

    def test_cancel_provider_uncertainty_keeps_reservation(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        with patch("stripe.PaymentIntent.cancel", side_effect=stripe.error.APIConnectionError("uncertain cancellation")):
            try:
                response = self.cancel_checkout("browser-one", key)
                self.assertGreaterEqual(response.status_code, 400)
            except stripe.error.APIConnectionError:
                pass
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as blocked:
            guest.assert_no_pending(self.session, self.order)
        self.assertEqual(blocked.exception.status_code, 409)

    def test_create_rejects_tampered_provider_binding_before_exposing_secret(self):
        def tampered(**kwargs):
            intent = self.provider_create(**kwargs)
            intent["metadata"]["order_id"] = "999999"
            return intent
        self.create_mock.side_effect = tampered
        response = self.start("browser-one")
        self.assertEqual(response.status_code, 400, response.text)
        self.assertNotIn("client_secret", response.json())

    def test_cancel_rejects_tampered_retrieved_binding_before_provider_cancel(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        self.intents[key]["metadata"]["order_id"] = "999999"
        with patch("stripe.PaymentIntent.cancel") as cancel:
            response = self.cancel_checkout("browser-one", key)
        self.assertEqual(response.status_code, 400, response.text)
        cancel.assert_not_called()

    def test_single_owner_quote_excludes_removed_line_and_includes_tip(self):
        self.order.session_id = "browser-one"
        self.order.tip_amount_cents = 50
        self.items[1].added_by_session = "browser-one"
        self.items[1].removed_by_customer = True
        self.items[1].status = models.OrderItemStatus.cancelled
        self.session.commit()
        with patch("stripe.PaymentIntent.create", return_value=stripe.StripeObject.construct_from({
                "id": "pi_owned_quote", "client_secret": "fixture_secret", "status": "requires_payment_method"}, None)) as create:
            response = self.start("browser-one")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["amount"], 550)
        self.assertEqual(create.call_args.kwargs["amount"], 550)
        view = self.client.get(f"/menu/{self.table.token}/order",
            params={"session_id": "browser-one"}).json()["order"]
        self.assertEqual(view["amount_remaining_cents"], 550)

    def test_single_owner_previous_line_payment_only_charges_remaining_line(self):
        self.order.session_id = "browser-one"
        self.items[1].added_by_session = "browser-one"
        self.session.commit()
        payments.record_payment(self.session, order=self.order, amount_cents=500,
            payment_method="cash", paid_by_user_id=None, order_item_ids=[self.items[0].id])
        response = self.start("browser-one")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["amount"], 700)
        self.assertEqual(response.json()["payment_scope"], "session_items")

    def test_single_owner_unallocated_cash_partial_requires_staff(self):
        self.order.session_id = "browser-one"
        self.items[1].added_by_session = "browser-one"
        self.session.commit()
        payments.record_payment(self.session, order=self.order, amount_cents=200,
            payment_method="cash", paid_by_user_id=None)
        response = self.start("browser-one")
        self.assertEqual(response.status_code, 409, response.text)
        self.create_mock.assert_not_called()

    def test_shared_account_webhook_ignores_valid_other_tenant_guest_attempt(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        obj = self.intents[key]
        obj["status"] = "succeeded"
        obj["amount_received"] = obj["amount"]
        receiver = models.Tenant(name="Other webhook destination", stripe_secret_key="sk_test_fixture")
        self.session.add(receiver)
        self.session.commit()
        event = {"type": "payment_intent.succeeded", "data": {"object": obj}}
        with patch("app.main.tenant_stripe_webhook_secret", return_value="whsec_fixture"), \
                patch("stripe.Webhook.construct_event", return_value=event):
            response = self.client.post(f"/payments/stripe/webhook/{receiver.id}",
                content=b"signed-fixture", headers={"stripe-signature": "fixture-signature"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["handled"])
        self.assertEqual(payments.list_active_payments(self.session, self.order.id), [])
        row = self.session.exec(select(models.GuestPaymentAttempt).where(
            models.GuestPaymentAttempt.stripe_payment_intent_id == key)).one()
        self.assertEqual(row.state, "pending")

    def test_own_webhook_intent_with_foreign_tenant_metadata_is_rejected(self):
        key = self.start("browser-one").json()["payment_intent_id"]
        other = models.Tenant(name="Foreign metadata tenant")
        self.session.add(other)
        self.session.commit()
        obj = self.intents[key]
        obj["status"] = "succeeded"
        obj["amount_received"] = obj["amount"]
        obj["metadata"]["tenant_id"] = str(other.id)
        response = self.webhook_route(obj)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(payments.list_active_payments(self.session, self.order.id), [])
