# Phase 1 technical acceptance

Completed 2026-09-07 UTC (2026-09-08 Europe/London).

Production SHA: 7a3e0cbd21e32347c85ee1eb05457ba674c1f382.
Deployment: https://github.com/mmarzook3/OneTable/actions/runs/34169110562

## Evidence

- Read-only launch checklist ran locally and on VPS; strict mode rejected incomplete configuration. Customer tenant1 still reports business_profile, allergens_reviewed and nfc_verified missing. Reporting these is the Phase1 requirement; launch completion remains a later gate.
- Synthetic owner login and exact tenant identity passed locally and live. Kitchen, bartender and waiter users passed permitted reads, 403 user/report API denials, and guarded UI route redirects.
- Table token, location and payment-account snapshots verified from fixture through order and Stripe metadata.
- Required nonpriced Soup finish modifier selected in browser and retained through basket, submission and kitchen. Item and order notes preserved. Duplicate submission replay returned the same order.
- Stripe test card entered through the real Card Element. Same-order new_order and order_paid WebSocket messages received while the KDS document remained unchanged. Unpaid ticket absent; paid ticket and notes present; fulfillment completed.
- Local order5398 and VPS tenant25/order149 passed modifier transaction and report checks. The actual staff receipt popup for both orders passed item/GBP5 totals, print-media cell bounds and Chromium PDF generation.
- VPS order149 subsequently received real signed partial/full refund events: cumulative100 then500 cents. Analytics gross500/refunds500/net0 and payment reconciliation passed. No real money moved.
- Synthetic fixtures, test payments and receipt jobs are explicitly retained for inspection. They use dedicated Scanaki Phase 1 tenant identities, not customer data.
- Release checks, Angular production build, final live public baseline, readiness, and scoped critical-log scan passed. Independent code reviews performed.

## Fixes shipped

Stable cart-row identity and current-row note updates prevent truncated note input. Receipt product/business names wrap instead of overflowing. Refund accounting preserves partial/full cumulative amounts under duplicates and event reordering. Browser tests wait for actual Angular controls, Stripe iframe and dynamically rendered postal fields.

## Scope boundaries

This closes the twelve Phase1 criteria, not the customer launch. Physical printer/NFC/tablet acceptance, offsite recovery and customer readiness sign-off remain Phase2/4. 3DS challenge and offline behavior are not claimed by the successful standard-card scenario; additional scenario coverage may be added without misrepresenting this evidence. The main transaction runner reports its bounded coverage; separate role, receipt, readiness and signed-refund checks supply the remaining phase evidence.
