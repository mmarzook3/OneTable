# Delivery payment-account snapshot correction

Checkpoint: 2026-09-08. Phase 3 remains in progress.

The real Stripe test-card checkout for synthetic order 157 succeeded at the
provider but application settlement rejected it: metadata contained
`payment_account_snapshot=tenant-default`, while the database field was null.
Amount, currency, order and tenant bindings matched. The 500 test-cent payment
was fully refunded. Order 157 remains retained for retries/controlled repair;
it must not be reinitialized through the intent-creation endpoint.

Intent creation now persists the existing account snapshot or canonical
`tenant-default` alongside amount/currency before provider creation or retrieval.
Metadata reads that stored value. Existing nonempty snapshots and the strict
settlement comparison are preserved; the validator was not relaxed.

- Fix: `927adc4de`; PR https://github.com/mmarzook3/OneTable/pull/12.
- Deployed SHA: `4ade17c0ecead2e02b742d38b0f071ff315c90c5`.
- Successful workflow: https://github.com/mmarzook3/OneTable/actions/runs/34248615813.
- Extended suite: **40 tests and 2 subtests passed locally and against the deployed VPS image**.
- New cases cover absent/existing snapshot values, stored/metadata agreement, rejection of a wrong account while unpaid, and successful matching confirmation.
- Independent review found no material blocker; the existing-intent retry branch is not separately covered by the new cases.
- Required builds, public browser smoke, health/readiness, reconciliation and checked service-log error markers passed.

A subsequent fresh provider-card retest passed. See
[the late-settlement follow-up](0108-late-settlement-and-card-acceptance.md) for
that result and the controlled repair of the retained fully refunded fixture.
Its original evidence is in `tmp/phase3-actual-delivery-card-ui.json`,
`tmp/phase3-actual-card-binding-diagnosis.json` and
`tmp/phase3-actual-card-retained-status.json`.

## SaaS setup access prerequisite

Global platform Stripe test credentials/prices/webhook configuration are absent;
restaurant guest credentials must not be silently reused. The approved account
reference is `acct_1TKKDqBUiyivQkj3`. The connected browser-control surface exposes
Chrome, but both selection and explicit creation of an in-app browser tab failed
with browser unavailable. This is a capability limitation, not proof of expired
Stripe authentication. The user is asked to open the approved account in Chrome.
No key was revealed, created or copied by this access check. Any approved project
credentials must remain private in Git-ignored `.env`, not the tracker or commits.
