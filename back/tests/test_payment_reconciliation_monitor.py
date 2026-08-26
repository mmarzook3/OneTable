from datetime import datetime, timedelta, timezone

from pg_client_mixin import PgClientTestCase

from app import models
from app.seeds.check_onetable_payment_reconciliation import reconciliation_issues


class TestPaymentReconciliationMonitor(PgClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tenant = models.Tenant(name="Reconciliation Monitor Test")
        self.session.add(self.tenant)
        self.session.flush()

    def _order(
        self,
        *,
        payment_state: str,
        paid: bool,
        released: bool,
        age_minutes: int = 0,
    ) -> models.Order:
        now = datetime.now(timezone.utc)
        order = models.Order(
            tenant_id=self.tenant.id,
            requires_prepayment=True,
            payment_state=payment_state,
            paid_at=now if paid else None,
            kitchen_released_at=now if released else None,
            created_at=now - timedelta(minutes=age_minutes),
        )
        self.session.add(order)
        self.session.flush()
        return order

    def test_fully_refunded_paid_order_is_reconciled(self) -> None:
        refunded = self._order(payment_state="refunded", paid=True, released=True)
        issue_ids = {row[0] for row in reconciliation_issues(self.session)}
        self.assertNotIn(refunded.id, issue_ids)

    def test_inconsistent_refund_and_stale_checkout_are_reported(self) -> None:
        bad_refund = self._order(payment_state="refunded", paid=False, released=True)
        stale = self._order(
            payment_state="awaiting_payment",
            paid=False,
            released=False,
            age_minutes=30,
        )
        issue_ids = {row[0] for row in reconciliation_issues(self.session)}
        self.assertIn(bad_refund.id, issue_ids)
        self.assertIn(stale.id, issue_ids)
