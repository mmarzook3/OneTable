# Shared Stripe test-account webhook routing

Checkpoint: 2026-09-08. Phase 3 remains in progress.

## Configuration and root cause

Four test destinations received the same account events. Two obsolete Phase 1
destinations (tenants 22 and 24) were disabled only after fixture ownership was
confirmed. The legitimate demo destination (tenant 1) and current fixture
destination (tenant 25) stayed enabled. A primary-agent SDK read independently
confirmed those states and test mode; no key or signing secret was printed.

The succeeded-event handler rejected a valid signed event at another legitimate
tenant destination even when the event was correctly bound to its actual order.
This caused unnecessary retries when tenants shared a Stripe account.

## Application correction

For the five supported payment/refund event types, an explicit foreign binding
is acknowledged with `received=true, handled=false` only after:

- Signature verification and the existing Connect-account check.
- Valid tenant/order identifiers and a matching stored foreign order/intent.
- Rejection of any payment-intent ownership conflict in the endpoint's tenant.

The ignored branch performs no state update, payment insertion or publication.
It has a distinct informational log. Events intended for the endpoint retain
their existing validation and processing errors. Success still requires its
bindings; metadata-free legacy lifecycle/refund events retain their existing
tenant-scoped intent lookups. This is not a blanket acknowledgement of malformed
or unauthenticated events.

## Release and verification

- Fix: `2c6978479`; protected PR https://github.com/mmarzook3/OneTable/pull/11.
- Deployed SHA: `c8a022cc47e5ecdf7004fd7b2419610f3a9f8880`.
- Successful workflow: https://github.com/mmarzook3/OneTable/actions/runs/34244462117.
- Local and deployed-image isolated suites: **11 tests and 13 subtests passed on each target**.
- Coverage includes all five foreign event types with no mutation, bad signatures, malformed/missing/inconsistent bindings, local ownership conflicts and wrong Connect account, plus existing refund-accounting regressions.
- Independent security review found no material blocker. Positive Connect-mode foreign acknowledgement and every malformed variant across every event type are not separately exercised.
- Public browser baseline, health/readiness, payment reconciliation, required builds and checked service-log markers passed after deployment.

Provider-side pending deliveries were last reported as three during preflight;
their drainage is not established by the application tests or endpoint-state
read. No new payment was created by those checks. Actual routing validation and
delivery-card acceptance remain separate work before claiming that provider flow
complete. No live-mode endpoint, real customer configuration or API-key permission
was changed. Original preflight evidence is under
`tmp/phase3-delivery-card-preflight-final.json` and
`tmp/phase3-delivery-card-webhook-preflight.json`.
