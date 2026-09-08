# Late settlement safeguards and delivery-card acceptance

Checkpoint: 2026-09-08. Phase 3 remains in progress.

## Fresh delivery-card flow

Synthetic order 158 passed the real Stripe test Card Element for GBP 5 after
verifying test mode and matching order/tenant/currency/account-snapshot data.
The signed webhook independently settled the order while browser confirmation
was held. Payment-success UI, paid tracking and reconciliation passed with no
browser error. A full sandbox refund followed; all eight related provider events
showed zero pending deliveries before its database rows were removed. No real
money moved. 3DS challenges, declines and mobile layout were not exercised.

Evidence: `tmp/phase3-fresh-delivery-card-ui.json` and
`tmp/phase3-fresh-delivery-card-cleanup.json`.

## Additional retry defect and fix

Successful settlement previously recalculated fulfillment status even on repeat
events, potentially rewinding progressed delivery or reopening a cancelled order.
The locked order query now refreshes any preloaded ORM state. Fulfillment status
is recalculated only for an eligible first settlement. Cancelled or fully
refunded settlement skips Kitchen release, inventory deduction, loyalty award
and delivery-specific publication. Legitimate payment-leg accounting and the
generic `order_paid` notification remain active; replay is not side-effect-free.

- Commits: `023bb7dd9`, `a2bcf4fde`.
- Protected PR: https://github.com/mmarzook3/OneTable/pull/13.
- Deployed SHA: `d12c4e42c7847593a45e750f726bdd528446cfe0`.
- Successful workflow: https://github.com/mmarzook3/OneTable/actions/runs/34252705491.
- Webhook regressions: **14 tests and 18 subtests passed locally and on VPS**.
- Broader regressions: **40 tests and 2 subtests passed locally and on VPS**.
- New cases cover cancelled/refunded delivery hook suppression, repeat delivery status, and stale preloaded state. The optional inventory switch is forced by a controlled test mock, not added to the production model.
- Independent review and the matching GitHub discussion were addressed before normal protected merge. Public browser smoke, builds, health/reconciliation and checked log markers passed.
- The stale-state case is not a full concurrent or post-commit event-order stress test.

## Controlled repair of the original refunded fixture

Order 157 was independently verified as the owned test fixture with a full
500-cent provider refund and matching payment bindings. Under a row lock, only
the missing snapshot (`null` -> `tenant-default`) and fulfillment status
(`pending` -> `cancelled`) were changed; other fields were preserved.

A locally re-signed existing Stripe test event was then replayed over public
HTTP, not through an internal-helper shortcut. It recorded legitimate accounting:
gross 500 minus refund 500 equals net zero. The order stayed cancelled/refunded,
with no Kitchen release or order-linked fulfillment changes; only the allowed
`order_paid` event was observed. No new charge, refund or intent was created.

Provider pending deliveries remained **1 before and after** that local replay.
Consequently fixture 157 is retained for provider retries, not claimed fully
cleaned. Historical order 149 separately still had three pending deliveries at
last observation. Destinations 1/25 remain enabled and 22/24 disabled. These old
counts must not be confused with the fresh order 158's eight settled events.

Evidence: `tmp/phase3-order157-controlled-repair.json` and
`tmp/phase3-order157-repair-logs.json`.

SaaS provider setup still needs access to the approved Stripe account through the
connected Chrome surface (tracker P3-04). Other scoped staff UI checks continue.
The final physical-test deferrals remain unchanged; no Phase 3 closure or
customer go-live is declared.
