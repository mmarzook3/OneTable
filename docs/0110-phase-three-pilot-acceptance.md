# Phase 3 pilot-scope acceptance

Date: 2026-09-08 UTC. Result: **PASSED for the approved pilot scope**.
This is not final customer go-live approval. Phase 4 and the agreed combined
physical acceptance session remain open.

## Release identity

- Payment implementation commit: `3c888945b` on `development`.
- Protected production PR: https://github.com/mmarzook3/OneTable/pull/15
- Deployed SHA: `4cef94ab6f05647a6926fa7dc44cca2ef51a3f29`.
- Successful deployment: https://github.com/mmarzook3/OneTable/actions/runs/34287597616
- Application version: `2.2.2`; the public landing footer reported the exact SHA.
- Required release checks and production Angular build passed without bypassing protection.

## Final payment correction

Overpayment validation previously compared new tender against the raw subtotal.
This rejected valid discounted payments and mishandled fees and prior payments.
The backend now validates against the canonical pre-tip base plus the selected
total tip, minus active prior payments, clamped at zero. Voided payments do not
count as credit. Existing tenant, underpayment and tip safeguards remain enforced.

Payment summaries now expose `amount_before_tip_cents`. The frontend uses this
server value instead of subtracting a potentially stale cached tip. It retrieves
a fresh summary before settlement and sends no payment when the summary is missing
or unavailable. Missing totals display an ellipsis, not a fabricated zero.

## Final verification

| Check | Local | VPS |
| --- | --- | --- |
| Isolated tips, split payments and loyalty suite | 33 tests / 23 subtests passed | 33 tests / 23 subtests passed against deployed image |
| Cash-only browser regression | 8 cases passed | 8 cases passed |
| Missing/503 summary | No payment request or ledger mutation | No payment request or ledger mutation |
| Discount, automatic tip, delivery fee and prior payment | Passed | Passed |
| Capped discount, voided payment exclusion, genuine underpayment | Passed | Passed |
| Stale initial tip | Canonical base used | Canonical base used |
| Public health/readiness, landing/mobile navigation and API docs | Passed on retry | Passed |
| Angular compilation | Passed after correction | Production build passed |

One initial local mobile-navigation timeout passed on retry without weakening
the test. An earlier failure-path test incorrectly expected a closed modal's
button to become enabled; it was corrected to assert modal closure, zero payment
requests and unchanged ledger, then reopen for the next scenario. These earlier
attempts were not counted as passes. Dependency deprecation warnings remain;
they did not cause failures.

VPS browser evidence completed at `2026-09-08T22:52:01.790Z`. All six synthetic
orders and their tenant were removed. Protected historical fixtures were unchanged.
Browser exceptions, unauthorized writes and provider calls were zero. No real
card payment, refund or customer email was sent for this correction.

Reproduce from the repository root:

```powershell
./scripts/test-phase3-backend.ps1 -Target local -Suite payments
./scripts/test-overpayment-net-due.ps1 -Target local
./scripts/test-phase3-backend.ps1 -Target vps -Suite payments
./scripts/test-overpayment-net-due.ps1 -Target vps
```

The VPS runner deliberately creates and removes private, marked synthetic
cash-only fixtures; use only within the approved pilot verification workflow.
Sanitized run evidence is under `tmp/phase3-overpayment-*-browser.json` and
`tmp/phase3-overpayment-*-cleanup.json`. Secrets are not in these records.

## Included modules and operating boundaries

The prior local/VPS evidence in Phase 3 records 0102 through 0109 remains part
of this acceptance; unchanged flows were not redundantly re-run in this release.

- Reservations: scoped availability, create, confirmation, staff visibility and cancellation passed. Notification delivery and advanced scheduling scenarios are not claimed verified.
- Delivery: the controlled sandbox card checkout, webhook settlement, tracking and full test refund passed in earlier evidence. Customer Stripe remains restaurant-payments-only.
- Offline ordering: supported pilot procedure is to sign in online and keep the staff app open. Cash reconnect and duplicate replay passed; offline card orders remain unpaid. Offline cold start/browser restart and card settlement are not claimed supported by this evidence.
- Android: the unified app and phone NFC read were verified previously. Deferred physical checks remain mandatory after Phase 4.
- Loyalty: earning/redemption, authoritative summary and the final settlement cases passed. Advanced wallet-provider or birthday/VIP behavior is not included in this acceptance claim.
- Customer accounts: the scoped account and authentication-boundary regressions passed previously.
- Restaurant groups: scoped membership/sharing and owned-versus-shared actions passed. Cross-tenant identity switching is not claimed as an available UI feature.
- SaaS subscriptions: pilot access is operator-managed and collection is directly by bank transfer, as explicitly directed by the user. A read-only production check found one matching venue with Pilot plan, Grandfathered status, unlimited ordering points and paywall enforcement disabled. No automatic bank reconciliation, subscription collection or nonpayment enforcement is claimed tested.

**Scope amendment:** Scanaki platform Stripe integration is deferred until after
the pilot. This supersedes older Phase 3 notes describing platform Stripe setup as
a blocker. The signed-in first customer's Stripe account must never be configured
for Scanaki SaaS collection. No platform Stripe products, credentials or prices
were created during this phase closure. Warehouses remain deferred and fiscal
integrations excluded.

## Runtime and remaining gates

All five Scanaki services were running. Backend, database and Redis reported
healthy; frontend and websocket bridge were running. The affected backend and
frontend recent log scans reported zero related errors. Public health and payment
reconciliation passed. Disk usage was 81%; the health check identified encrypted
backup `scanaki_20260908_224903.sql.gz.enc`. Existing recurring backup work continues.
The previously confirmed cloud set remains separate from this newer VPS backup;
this document does not claim that the newer set was copied to Drive.

Historical, fully refunded sandbox fixtures with pending provider retries remain
retained and documented, not silently removed or claimed drained. They are not
customer payments and were not changed by the final cash regressions.

Phase 4 must reconcile release/recovery/rollback/monitoring evidence and deliver
the final go/no-go decision. After Phase 4 engineering, complete the one agreed
physical session: receipt/kitchen paper printing, spare NFC write/read-back,
camera permission with printed QR, and venue Wi-Fi interruption/recovery.
Do not represent these deferred checks as passed or invite customer go-live yet.
