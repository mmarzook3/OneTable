# Shared-record actions and loyalty payment summary

Checkpoint: 2026-09-08. Phase 3 remains in progress.

## Corrections

Shared billing customers previously offered Edit/Delete despite server rejection.
Those row controls and their handlers now respect sharing/ownership as well as
write permission. Local customer actions remain available.

Catalog menu membership/removal previously selected active sibling-owned products.
Removal now resolves only the current tenant's product. A shared-only catalog
entry can be copied into the local menu; removing that local copy preserves the
sibling source.

Loyalty redemption updated a discount but left cached reconciliation amounts
stale. The first attempted delta calculation was rejected in review because a
large reward could consume a displayed tip. The final implementation fetches
authoritative payment totals before enabling payment, updates the list/modal,
and closes an unverifiable stale modal on summary-fetch failure without repeating
redemption. Consumed tokens clear after redemption and on modal close; late
responses do not overwrite another order's modal or newly entered token.

The new fixture helper uses explicit runtime validation, not assertions that
Python optimization could remove. Safe import, invalid cleanup under `python -O`
before database access, and an optimized seed/cleanup cycle all passed.

## Release and verification

- Main fixes: `e9f4217b4`, `1beb19848`, `213461d4c`.
- Protected PR: https://github.com/mmarzook3/OneTable/pull/14.
- Deployed SHA: `d20e930bfd05dd3ea749e0e4423ea20e216edded`.
- Successful workflow: https://github.com/mmarzook3/OneTable/actions/runs/34262611675.
- Angular rebuild, required builds, public browser baseline, health/reconciliation and checked service-log markers passed.
- Review findings were addressed and discussion threads resolved before normal protected merge.

Six shared-action checks passed locally and on VPS: shared CRM controls absent;
local edit/delete succeed; shared-only catalog offers local add; local copy is
created; removal uses its exact local ID and preserves the active sibling.
Category options alone were fixture-stubbed; record/product responses and actions
were real. Dedicated fixture rows were removed.

Five loyalty cases passed locally and on VPS:

- Basic: due 500 -> 300 cents, with actual synthetic cash settlement of 300.
- Fees/tips/prior payment: due/paid/remaining 650/100/550 -> 450/100/350.
- Oversized reward: 150 -> 50 cents, preserving the tip.
- Simulated summary GET failure: payment stayed disabled while pending, the modal closed safely, one redemption and zero payment requests occurred.
- Held response and modal switch: consumed token cleared, the other order's 700-cent summary and newly entered token stayed intact, with zero mutation of that other order.

The fee/tip/partial and oversized cases validate display/reconciliation, not
settlement in every payment mode. No provider call or real charge occurred.
All six VPS test orders and their fixture tenant were removed; protected orders
147/157 were unchanged.

## Evidence and remaining scope

Reusable tests:

- `front/scripts/test-group-shared-actions.mjs`
- `scripts/phase3-group-actions-fixture.py`
- `front/scripts/test-loyalty-payment-summary.mjs`

Sanitized VPS evidence:

- `tmp/phase3-group-shared-actions-vps-d20e930-38d122a653ee43eea09ad2bf573b3387.json`
- `tmp/phase3-loyalty-summary-five-cases-vps.json`
- `tmp/phase3-loyalty-summary-five-cases-vps-cleanup.json`

A separate pre-existing overpayment/tip-mode validation still uses an
undiscounted subtotal and is the next investigation. That mode is not declared
passed here. SaaS provider credential setup still awaits an accessible approved
Stripe browser session (P3-04). Final physical checks remain deferred as agreed;
this is not Phase 3 closure or customer go-live.
