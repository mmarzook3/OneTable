# Pilot phase 1: core transaction journey

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 1 core transaction journey
- **URL:** None
- **Labels:** pilot-readiness, phase-1

## Meta

- **Status:** `in-progress`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** Verified Phase 0 task archived under `agents2/tasks/done/`
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## Dependency Gate

Do not rename this task or edit application code until Phase 0 is verified and archived. If it is missing, record the blocker and exit.

## 1. Objective

### Verified checkpoint 2026-09-07

Commit b290dc55f corrected fixture-location verification to use /tables rather than /tables/with-status, which omits location_id. The bounded runner passed locally (synthetic order 5386) and against the VPS (synthetic tenant 22, order 146). Both runs verified login, tenant/table identity, sandbox Stripe settlement, duplicate order idempotency, paid-only kitchen visibility, fulfillment, receipt payload and sales totals. Test tooling was copied to /opt/scanaki/app/front/scripts before the VPS test. VPS payment reconciliation passed and containers remain running. Application release is still 114e73186; refund commit b75c82c6c has not yet been deployed.

Phase remains open: browser basket/card entry, webhook delivery/retries, restricted roles, refund/net reporting, no-refresh event delivery and receipt layout still need coverage. Do not interpret passed-bounded-coverage as full phase acceptance. Fixtures and test payments retained explicitly for inspection; no real money moved.

Build one deterministic test journey that traces a unique order through the complete core pilot lifecycle.

## 2. Acceptance Criteria

- [ ] A read-only readiness check reports missing tenant configuration.
- [ ] Pilot roles verify allowed and forbidden routes.
- [ ] A known QR/plaque resolves the correct tenant, location, and table/room context.
- [ ] The browser adds products/modifiers/notes and verifies prices, tax, and totals.
- [ ] The order is submitted idempotently and its ID is retained across every stage.
- [ ] Sandbox payment releases exactly one kitchen/bar ticket.
- [ ] WebSocket delivery is proven without a page refresh.
- [ ] The ticket completes through required kitchen states without skips.
- [ ] Receipt content and print jobs match the order.
- [ ] An authorized sandbox refund updates payment state and reconciliation.
- [ ] Reports show gross, refund, net, location, point, and products for the same order.
- [ ] Test data is safely cleaned up or explicitly marked for disposable environments.

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

