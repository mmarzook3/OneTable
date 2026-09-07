"""Configure a dedicated synthetic Phase 1 tenant using existing test credentials.

Explicit invocation only. Never changes the source tenant or prints credentials.
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
from app.models import Tenant
from app.tenant_payment_credentials import (
    encrypt_payment_secret,
    tenant_stripe_secret,
    tenant_stripe_webhook_secret,
)

EVENTS = [
    "payment_intent.succeeded", "payment_intent.payment_failed",
    "payment_intent.canceled", "payment_intent.processing", "charge.refunded",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tenant-id', type=int, required=True)
    parser.add_argument('--source-tenant-id', type=int, required=True)
    parser.add_argument('--manifest-file', required=True)
    args = parser.parse_args()
    with Session(engine) as session:
        target = session.get(Tenant, args.tenant_id)
        source = session.get(Tenant, args.source_tenant_id)
        if (not target or not source or target.id == source.id
                or not target.name.startswith('Scanaki Phase 1 ') or target.is_demo):
            raise SystemExit('Requires a separate synthetic Scanaki Phase 1 tenant')
        secret = tenant_stripe_secret(source) or ''
        public = source.stripe_publishable_key or ''
        if not secret.startswith(('sk_test_', 'rk_test_')) or not public.startswith('pk_test_'):
            raise SystemExit('Source must have explicit matching test-mode credentials')
        envelope = json.loads(Path(args.manifest_file).read_text(encoding='utf-8-sig'))
        payload = envelope['payload']
        signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, envelope['signature']):
            raise SystemExit('Invalid synthetic fixture signature')
        fixture = json.loads(payload)
        if (fixture.get('tenant_id') != target.id or fixture.get('synthetic') is not True
                or fixture.get('livemode') is not False or fixture.get('target') != 'remote'
                or fixture.get('base_url') != 'https://scanaki.uk'
                or target.name != f"Scanaki Phase 1 {fixture.get('run_id')}"
                or not 0 <= time.time() - fixture.get('created_at', 0) <= 1800
                or tenant_stripe_secret(target) != secret
                or target.stripe_publishable_key != public):
            raise SystemExit('Requires a fresh signed remote synthetic fixture with matching test keys')
        url = f'https://scanaki.uk/api/payments/stripe/webhook/{target.id}'
        matches = [e for e in stripe.WebhookEndpoint.list(api_key=secret, limit=100).auto_paging_iter()
                   if e.url == url]
        if matches:
            metadata = matches[0].metadata
            if not isinstance(metadata, dict):
                metadata = metadata.to_dict()
            if (len(matches) != 1 or matches[0].livemode or matches[0].status != 'enabled'
                    or set(matches[0].enabled_events) != set(EVENTS)
                    or metadata.get('scanaki_phase1_run_id') != fixture['run_id']):
                raise SystemExit('Existing test destination needs review; no credentials rotated')
        # Replay the same create within the fresh manifest window to recover the
        # signing secret after an interrupted database commit, without rotation.
        endpoint = stripe.WebhookEndpoint.create(
            api_key=secret, url=url, enabled_events=EVENTS,
            description=f'Scanaki Phase 1 synthetic tenant {target.id}',
            metadata={'scanaki_phase1_run_id': fixture['run_id']},
            idempotency_key=f'scanaki-phase1-webhook-{target.id}',
        )
        if endpoint.livemode or (matches and endpoint.id != matches[0].id):
            raise SystemExit('Unexpected destination identity; stop and investigate')
        target.stripe_webhook_secret_encrypted = encrypt_payment_secret(endpoint.secret)
        session.add(target)
        session.commit()
        print(f'Test credentials and sandbox webhook configured for synthetic tenant {target.id}')


if __name__ == '__main__':
    main()
