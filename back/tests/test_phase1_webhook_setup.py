"""Isolated webhook setup tests: no database connections or Stripe requests."""
import hashlib
import hmac
import io
import json
import unittest
from contextlib import ExitStack, redirect_stdout
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.seeds import configure_pilot_stripe_webhook as setup
from app.tenant_payment_credentials import decrypt_payment_secret, encrypt_payment_secret


class TestPhase1WebhookSetup(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.secret = 'sk_test_phase1_mock_only'
        self.webhook_secret = 'whsec_phase1_mock_only'
        self.source = self.tenant(1, 'Source')
        self.target = self.tenant(2, 'Scanaki Phase 1 run-123')
        self.fixture = dict(tenant_id=2, synthetic=True, livemode=False,
                            target='remote', base_url='https://scanaki.uk',
                            run_id='run-123', created_at=10000)
        self.session = MagicMock()
        self.session.get.side_effect = lambda model, key: {1: self.source, 2: self.target}.get(key)
        session_factory = self.stack.enter_context(patch.object(setup, 'Session'))
        session_factory.return_value.__enter__.return_value = self.session
        # Any accidental use of the actual engine fails without connecting.
        self.stack.enter_context(patch.object(setup.engine, 'connect', side_effect=AssertionError('DB access')))
        self.stripe = self.stack.enter_context(patch.object(setup.stripe, 'WebhookEndpoint'))
        self.stripe.list.return_value.auto_paging_iter.return_value = []
        self.endpoint = SimpleNamespace(
            id='we_mock', url='https://scanaki.uk/api/payments/stripe/webhook/2',
            livemode=False, status='enabled', enabled_events=list(setup.EVENTS),
            metadata={'scanaki_phase1_run_id': 'run-123'}, secret=self.webhook_secret,
        )
        self.stripe.create.return_value = self.endpoint
        self.read = self.stack.enter_context(patch.object(setup.Path, 'read_text'))
        self.stack.enter_context(patch.object(setup.time, 'time', return_value=10000))
        self.stack.enter_context(patch('sys.argv', [
            'configure', '--tenant-id', '2', '--source-tenant-id', '1',
            '--manifest-file', 'mock-manifest.json',
        ]))
        self.output = io.StringIO()
        self.stack.enter_context(redirect_stdout(self.output))
        self.sign()

    def tenant(self, tenant_id, name):
        return SimpleNamespace(
            id=tenant_id, name=name, is_demo=False, stripe_payment_mode='tenant_keys',
            stripe_secret_key=None,
            stripe_secret_key_encrypted=encrypt_payment_secret(self.secret),
            stripe_publishable_key='pk_test_phase1_mock_only',
            stripe_webhook_secret_encrypted=None,
        )

    def sign(self):
        payload = json.dumps(self.fixture)
        signature = hmac.new(self.secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        self.read.return_value = json.dumps(dict(payload=payload, signature=signature))

    def assert_rejected_before_stripe(self):
        with self.assertRaises(SystemExit):
            setup.main()
        self.stripe.list.assert_not_called()
        self.stripe.create.assert_not_called()
        self.session.add.assert_not_called()
        self.session.commit.assert_not_called()

    def test_success_encrypts_only_webhook_secret_and_does_not_print_secrets(self):
        source_before = vars(self.source).copy()
        target_before = vars(self.target).copy()
        setup.main()
        self.assertEqual(vars(self.source), source_before)
        actual = vars(self.target).copy()
        encrypted = actual.pop('stripe_webhook_secret_encrypted')
        target_before.pop('stripe_webhook_secret_encrypted')
        self.assertEqual(actual, target_before)
        self.assertNotEqual(encrypted, self.webhook_secret)
        self.assertEqual(decrypt_payment_secret(encrypted), self.webhook_secret)
        self.session.add.assert_called_once_with(self.target)
        self.session.commit.assert_called_once_with()
        for value in (self.secret, self.webhook_secret, encrypted):
            self.assertNotIn(value, self.output.getvalue())
        self.stripe.create.assert_called_once_with(
            api_key=self.secret, url=self.endpoint.url, enabled_events=setup.EVENTS,
            description='Scanaki Phase 1 synthetic tenant 2',
            metadata={'scanaki_phase1_run_id': 'run-123'},
            idempotency_key='scanaki-phase1-webhook-2',
        )

    def test_tampered_signature_rejected(self):
        envelope = json.loads(self.read.return_value)
        envelope['signature'] = '0' * 64
        self.read.return_value = json.dumps(envelope)
        self.assert_rejected_before_stripe()

    def test_invalid_signed_fixture_rejected(self):
        original = self.fixture.copy()
        for field, value in [('tenant_id', 1), ('synthetic', False), ('livemode', True),
                             ('target', 'local'), ('base_url', 'https://other.invalid'),
                             ('run_id', 'other'), ('created_at', 8199), ('created_at', 10001)]:
            with self.subTest(field=field, value=value):
                self.fixture = dict(original, **{field: value})
                self.sign()
                self.assert_rejected_before_stripe()

    def test_customer_name_and_demo_target_rejected(self):
        for field, value in [('name', 'Customer restaurant'), ('is_demo', True)]:
            with self.subTest(field=field):
                with patch.object(self.target, field, value):
                    self.assert_rejected_before_stripe()

    def test_missing_or_same_tenant_rejected(self):
        for rows in ([None, self.source], [self.target, None], [self.source, self.source]):
            with self.subTest(rows=rows):
                self.session.get.side_effect = rows
                self.assert_rejected_before_stripe()

    def test_mismatched_target_keys_rejected(self):
        for field, value in [('stripe_secret_key_encrypted', encrypt_payment_secret('sk_test_other')),
                             ('stripe_publishable_key', 'pk_test_other')]:
            with self.subTest(field=field):
                with patch.object(self.target, field, value):
                    self.assert_rejected_before_stripe()

    def test_live_source_keys_rejected(self):
        for field, value in [('stripe_secret_key_encrypted', encrypt_payment_secret('sk_live_mock')),
                             ('stripe_publishable_key', 'pk_live_mock')]:
            with self.subTest(field=field):
                with patch.object(self.source, field, value):
                    self.assert_rejected_before_stripe()

    def test_conflicting_existing_endpoint_rejected_without_writes(self):
        self.stripe.list.return_value.auto_paging_iter.return_value = [self.endpoint]
        for field, value in [('livemode', True), ('status', 'disabled'),
                             ('enabled_events', ['*']), ('metadata', {}),
                             ('metadata', {'scanaki_phase1_run_id': 'other'})]:
            with self.subTest(field=field, value=value):
                with patch.object(self.endpoint, field, value):
                    with self.assertRaises(SystemExit):
                        setup.main()
                self.stripe.create.assert_not_called()
                self.session.add.assert_not_called()
                self.session.commit.assert_not_called()

    def test_duplicate_endpoints_rejected(self):
        self.stripe.list.return_value.auto_paging_iter.return_value = [self.endpoint, self.endpoint]
        with self.assertRaises(SystemExit):
            setup.main()
        self.stripe.create.assert_not_called()
        self.session.commit.assert_not_called()

    def test_existing_endpoint_recovers_missing_or_stale_secret(self):
        self.stripe.list.return_value.auto_paging_iter.return_value = [self.endpoint]
        for previous in (None, encrypt_payment_secret('whsec_stale')):
            with self.subTest(previous=bool(previous)):
                self.target.stripe_webhook_secret_encrypted = previous
                setup.main()
                self.assertEqual(decrypt_payment_secret(self.target.stripe_webhook_secret_encrypted),
                                 self.webhook_secret)
        self.assertEqual(self.stripe.create.call_args_list[0], self.stripe.create.call_args_list[1])

    def test_commit_failure_retry_replays_identical_create(self):
        self.session.commit.side_effect = [RuntimeError('simulated commit failure'), None]
        with self.assertRaisesRegex(RuntimeError, 'simulated commit failure'):
            setup.main()
        self.assertEqual(self.output.getvalue(), '')
        # Model a fresh session loading the uncommitted database state on retry.
        self.target.stripe_webhook_secret_encrypted = None
        self.stripe.list.return_value.auto_paging_iter.return_value = [self.endpoint]
        setup.main()
        self.assertEqual(self.stripe.create.call_args_list[0], self.stripe.create.call_args_list[1])
        self.assertEqual(decrypt_payment_secret(self.target.stripe_webhook_secret_encrypted),
                         self.webhook_secret)

    def test_unexpected_returned_identity_or_live_endpoint_not_saved(self):
        self.stripe.list.return_value.auto_paging_iter.return_value = [self.endpoint]
        for values in (dict(id='we_other', livemode=False), dict(id='we_mock', livemode=True)):
            with self.subTest(values=values):
                self.stripe.create.return_value = SimpleNamespace(**values)
                with self.assertRaises(SystemExit):
                    setup.main()
                self.session.add.assert_not_called()
                self.session.commit.assert_not_called()
                self.assertIsNone(self.target.stripe_webhook_secret_encrypted)


if __name__ == '__main__':
    unittest.main()
