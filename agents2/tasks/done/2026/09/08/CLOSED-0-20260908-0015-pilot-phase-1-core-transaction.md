# Pilot phase 1: core transaction journey

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 1 core transaction journey
- **URL:** None
- **Labels:** pilot-readiness, phase-1

## Meta

- **Status:** `verified`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** Verified Phase 0 task archived under `agents2/tasks/done/`
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## Dependency Gate

Do not rename this task or edit application code until Phase 0 is verified and archived. If it is missing, record the blocker and exit.

## 1. Objective

### Verified checkpoint 2026-09-07

Latest checkpoint: test tooling 29609b80b was deployed to the VPS. Kitchen, bartender and waiter each passed local and live login, allowed product/order reads, forbidden user/report APIs (403), and protected UI redirects. Browser test-card entry passed locally (order5397) and on VPS tenant24/order148; exact new_order and order_paid WebSocket events matched that same order. Stripe's dynamically rendered postal field required an explicit visible-state wait. Order148 then passed actual signed partial/full refund delivery and gross500/refunds500/net0 analytics. Refund fixture validation now tolerates only the known server-added PAID marker while retaining signed tenant/table/location/run checks. No real money moved. Remaining: receipt layout, modifier/readiness checks and any additional required negative payment coverage; Phase 1 remains open.

Later checkpoint: production abd78977c571def96ff8c045f6485efe973ba9f4, deployment 34166749507 passed. Refund accounting deployed via PR2; actual Stripe partial/full refunds on synthetic tenant22/order146 delivered signed webhook events (100 then 500 cumulative cents), analytics gross500/refunds500/net0, reconciliation clean. Webhook helper passed 12 tests/26 subtests and a real idempotent rerun.

Expanded browser runner found and fixed a real note-editing bug: mutable note-derived cart keys lost subsequent input or closed the editor. Stable UI keys and updates against current row state now preserve notes. Local synthetic order5391 and VPS tenant23/order147 passed actual UI basket/notes/submission, idempotency, sandbox settlement, paid KDS ticket+notes without navigation, fulfillment, receipt payload and report reconciliation. VPS observed one WebSocket connection and five frames; matching-order push causality is not yet asserted. Card entry/3DS, restricted roles and receipt layout remain open. These checkpoints do not close Phase 1.

Commit b290dc55f corrected fixture-location verification to use /tables rather than /tables/with-status, which omits location_id. The bounded runner passed locally (synthetic order 5386) and against the VPS (synthetic tenant 22, order 146). Both runs verified login, tenant/table identity, sandbox Stripe settlement, duplicate order idempotency, paid-only kitchen visibility, fulfillment, receipt payload and sales totals. Test tooling was copied to /opt/scanaki/app/front/scripts before the VPS test. VPS payment reconciliation passed and containers remain running. Application release is still 114e73186; refund commit b75c82c6c has not yet been deployed.

Phase remains open: browser basket/card entry, webhook delivery/retries, restricted roles, refund/net reporting, no-refresh event delivery and receipt layout still need coverage. Do not interpret passed-bounded-coverage as full phase acceptance. Fixtures and test payments retained explicitly for inspection; no real money moved.

Build one deterministic test journey that traces a unique order through the complete core pilot lifecycle.

## 2. Acceptance Criteria

All criteria below verified across the transaction, role, receipt, readiness and signed-refund checks. Evidence: docs/0098-phase-one-acceptance.md. Production deployment 34169110562 succeeded and final VPS checks passed. Customer launch readiness remains explicitly separate.

- [x] A read-only readiness check reports missing tenant configuration.
- [x] Pilot roles verify allowed and forbidden routes.
- [x] A known QR/plaque resolves the correct tenant, location, and table/room context.
- [x] The browser adds products/modifiers/notes and verifies prices, tax, and totals.
- [x] The order is submitted idempotently and its ID is retained across every stage.
- [x] Sandbox payment releases exactly one kitchen/bar ticket.
- [x] WebSocket delivery is proven without a page refresh.
- [x] The ticket completes through required kitchen states without skips.
- [x] Receipt content and print jobs match the order.
- [x] An authorized sandbox refund updates payment state and reconciliation.
- [x] Reports show gross, refund, net, location, point, and products for the same order.
- [x] Test data is safely cleaned up or explicitly marked for disposable environments.

## 3. Implementation Scope

**In scope:** One orchestrated transaction test, unique run IDs, safe teardown, failure screenshots/logs, and strict nonzero exits.

**Out of scope:** Real production payments/refunds, physical printer proof, optional modules, and unrelated UI redesign.

## 4. Testing Instructions

Run locally against the Phase 0 browser-test profile. Use Stripe test mode only. The final command must cover the complete sequence and must fail on any skipped stage.

Pass when one order ID is visible in every expected subsystem and the test leaves no ambiguous result.

## Status Tracker

| Phase | Status | Notes |
|---|---|---|
| Created | Complete | |
| Prerequisite | Passed | Phase 0 archived with production verification |
| Implementation | In progress | Stripe test account and existing five-event webhook verified; isolated fixture and refund accounting in progress |
| Testing | Pending | |

