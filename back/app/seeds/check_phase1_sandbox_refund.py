"""Verify partial/full refunds on an explicitly selected synthetic test order.

Stripe must deliver the signed events; this check does not simulate webhooks or
change order state directly. Retains the test order for audit.
"""
import argparse
import hashlib
import hmac
import json
import time
from pathlib import Path

import stripe
from sqlmodel import Session

from app.db import engine
from app.models import Order, Tenant, User
from app.tenant_payment_credentials import tenant_stripe_secret


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tenant-id', type=int, required=True)
    parser.add_argument('--order-id', type=int, required=True)
    parser.add_argument('--manifest-file', required=True)
    parser.add_argument('--execute-sandbox', action='store_true', required=True)
    args = parser.parse_args()
    with Session(engine) as session:
        tenant = session.get(Tenant, args.tenant_id)
        order = session.get(Order, args.order_id)
        if (not tenant or not order or order.tenant_id != tenant.id
                or not tenant.name.startswith('Scanaki Phase 1 ') or tenant.is_demo
                or order.deleted_at is not None or order.paid_at is None):
            raise SystemExit('Requires a paid order in a synthetic Phase 1 tenant')
        key = tenant_stripe_secret(tenant) or ''
        if not key.startswith(('sk_test_', 'rk_test_')):
            raise SystemExit('Explicit test key required')
        envelope = json.loads(Path(args.manifest_file).read_text(encoding='utf-8-sig'))
        signature = hmac.new(key.encode(), envelope['payload'].encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, envelope['signature']):
            raise SystemExit('Invalid synthetic fixture signature')
        fixture = json.loads(envelope['payload'])
        if (fixture.get('tenant_id') != tenant.id or fixture.get('synthetic') is not True
                or fixture.get('livemode') is not False
                or tenant.name != f"Scanaki Phase 1 {fixture.get('run_id')}"
                or order.public_idempotency_key != fixture.get('run_id')):
            raise SystemExit('Order must belong to the signed synthetic test run')
        intent = stripe.PaymentIntent.retrieve(order.stripe_payment_intent_id, api_key=key)
        if (intent.livemode or intent.status != 'succeeded' or intent.amount != 500
                or intent.currency != 'gbp' or order.payment_amount_cents != 500
                or str(intent.metadata['tenant_id']) != str(tenant.id)
                or str(intent.metadata['order_id']) != str(order.id)):
            raise SystemExit('Payment does not match the GBP 5 synthetic test fixture')
        intent_id = intent.id
        released_at = order.kitchen_released_at

    for amount, cumulative, state in [(100, 100, 'partially_refunded'), (400, 500, 'refunded')]:
        refund = stripe.Refund.create(
            payment_intent=intent_id, amount=amount, api_key=key,
            idempotency_key=f'phase1-refund-{args.tenant_id}-{args.order_id}-{cumulative}',
        )
        if refund.status != 'succeeded':
            raise SystemExit('Sandbox refund did not succeed; inspect provider status')
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            with Session(engine) as session:
                order = session.get(Order, args.order_id)
                if order.refunded_amount_cents == cumulative and order.payment_state == state:
                    if order.kitchen_released_at != released_at:
                        raise SystemExit('Refund changed the original kitchen release timestamp')
                    print(f'PASS signed webhook: refund total {cumulative} cents, state {state}', flush=True)
                    break
            time.sleep(2)
        else:
            raise SystemExit('Stripe refund succeeded but signed webhook state was not observed within 60s')
    from app.location_routes import location_analytics
    from app.seeds.check_onetable_payment_reconciliation import reconciliation_issues
    with Session(engine) as session:
        totals = location_analytics(current_user=User(tenant_id=args.tenant_id),
            from_date=None, to_date=None, location_id=None, session=session)['combined']
        if (totals['gross_sales_cents'], totals['refund_amount_cents'], totals['net_sales_cents']) != (500, 500, 0):
            raise SystemExit('Synthetic tenant gross/refund/net totals do not reconcile')
        if reconciliation_issues(session):
            raise SystemExit('Payment reconciliation reported issues')
    print('PASS analytics service: gross 500, refunds 500, net 0 cents; reconciliation clean')
    print('PASS sandbox partial/full refund delivery; no real money moved')


if __name__ == '__main__':
    main()
