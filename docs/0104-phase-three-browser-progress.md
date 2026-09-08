# Phase 3 browser verification progress

Checkpoint: 2026-09-08. Phase 3 remains in progress.

## Delivery tracking fix: deployed and verified

An incomplete tracking link displayed its error before retaining the validated
restaurant ID, so its return link incorrectly targeted `/delivery/0`.
The component now retains valid restaurant context before the early return and
does not show a restaurant link when the ID is invalid.

- Fix: `172c1b0b2`; protected PR https://github.com/mmarzook3/OneTable/pull/8.
- Deployed SHA: `5881bb8663c3bfd7d73a33cd243607a31047f323`.
- Successful workflow: https://github.com/mmarzook3/OneTable/actions/runs/34232728359.
- Four focused Puppeteer cases passed locally and on VPS: no tracking parameters, missing token, missing order, invalid restaurant ID.
- Tests assert correct return links, visible errors, no order status disclosure and no browser runtime error.
- Local Angular rebuild and required production build passed. Post-deploy health, reconciliation and checked service-log error patterns passed.

Earlier read-only delivery checks also passed menu/cart/address-form rendering,
empty-form rejection, configured delivery CTA and invalid-token denial. They did
not create delivery orders, execute payment or prove a courier/tracking lifecycle.
An initial exploratory run recorded an unattributed browser error and translation
key flag; focused reproductions had neither. Those observations are not claimed
as independently fixed defects.

## Offline ordering: scoped local and VPS browser pass

The actual staff route is `/staff/orders`; `/orders` is the public directory.
Using warm-loaded synthetic staff sessions, Chromium offline emulation proved:

- Cash sale persisted pending in local storage with no offline POST.
- Reconnect automatically submitted one initial sync request.
- The resulting synthetic cash sale had one payment row for 1,000 cents.
- Sequential same-key replay returned the same order, without another payment.
- Independent database checks found one idempotency row per tested order.
- Deferred card remained pending/unpaid, with `needs_payment=true`, no payment method and zero payment rows.

No provider payment, email or fiscal operation was performed. Short-lived test
authentication was generated privately; no login-endpoint retry or throttle
bypass was used. Dedicated fixtures were removed with absence assertions; existing
shared fixtures and order 147 were preserved. Sanitized evidence is retained at
`tmp/phase3-offline-browser-evidence-20260908.json` on the laptop, outside the VPS
deployment's temporary-file replacement path.

**Pilot operating note:** open and sign into the staff app while online before
a connection interruption, and keep it open. This evidence does not establish
offline cold start or browser restart recovery. Card payment is deferred until
online; capturing an offline order does not mean its card payment succeeded.
Replay evidence is sequential, not a concurrent/lost-acknowledgement stress test.
The harness did not independently pin the release SHA; the contemporaneous
parent deployment checkpoint was `8bf1720c` before the tracking-only release.

## Customer account UI: navigation regression corrected

Both local and VPS actual-form checks passed one synthetic customer login,
verified identity, empty order history, logout, cookie removal and subsequent
HTTP 401 denial for customer identity/orders. Fixtures were removed and no
registration or email request was sent.

The initial check found fresh `/customer` navigation incorrectly reaching staff
`/login` after logout. Access denial worked; the shared interceptor attempted
staff refresh/logout for a customer-session 401 before the customer guard could
complete its redirect. Customer-namespace 401 errors now propagate directly to
customer guards/components, without entering the staff refresh/logout flow.
The existing staff logic and generic route helper were left unchanged.

- Fix `1962e8860`; PR https://github.com/mmarzook3/OneTable/pull/9.
- Deployed `6f254bf613ce39f6f16e2a58d2802e45b23bd7fb` in successful run https://github.com/mmarzook3/OneTable/actions/runs/34234609412.
- Customer redirect checks passed locally and on VPS at 390px/1280px with zero staff refresh/logout requests. Unauthenticated staff navigation still reaches staff login.
- Angular local/production builds, post-deploy health/reconciliation and checked service-log markers passed. Independent review found no material blocker.
- Coverage does not include a successful staff-refresh cycle or an already-authenticated staff session in the new focused test.

Original customer lifecycle evidence is retained in
`tmp/phase3-customer-account-ui-evidence-20260908.json`.

## Loyalty: enabled-state bounded functional pass

Live synthetic enrollment and the public balance card passed the sequence
0 -> 2 -> 0 stamps. Authenticated API cash settlement of 500 cents produced
exactly one earning entry; redemption applied a 200-cent discount and left a
300-cent order balance. Duplicate settlement/redemption returned HTTP 400;
database checks confirmed no duplicate earnings or negative balance. The
browser reported no runtime errors. Own orders/membership/associated rows were
removed, program configuration restored exactly, and shared order 147 preserved.
No email or external payment occurred.

Evidence: `tmp/phase3-loyalty-functional-ui-final.json` and
`tmp/phase3-loyalty-functional-cleanup-final.json`. This covers enrollment/balance
UI and earning/redemption APIs, not the staff payment/redemption modal UI, wallet
providers, birthday/referral/VIP rules, concurrency or mobile layout.

Reservation, delivery, subscription and group end-to-end acceptance remain open.
The approved final physical session is unchanged; no Phase 3 completion or
customer go-live is declared here.

## Restaurant groups: bounded live management pass

Dedicated synthetic owners exercised the Settings group tab on the VPS:
create, private-code join, two-member listing, rename, sharing toggles, hub
designation, leaving and final-member group deletion. Browser-authenticated API
checks proved pre-join and outsider isolation, sibling shared reads, rejected
sibling customer edits, rejected outsider edits/hub choices, and revoked reads
after disabling sharing or leaving. Owner session tenant identities did not
change. All dedicated tenants, group links and dependent fixture rows were
removed; shared tenant 23 and order 147 were untouched.

This does not establish tenant-identity switching: the inspected UI has a hub
selector, not an authenticated tenant switch control. Catalog/CRM rendering,
non-owner/mobile UI, concurrent joins and cross-restaurant fulfillment were not
exercised. Settings-created synthetic warehouse/tax rows were included in
cleanup; this does not enable the deferred warehouse module. Evidence:
`tmp/phase3-restaurant-groups-ui-evidence-20260908.json`.

## Delivery: live cash-supported lifecycle pass

A dedicated synthetic order passed public menu -> cart -> address -> creation
and payment-options UI. Valid tracking updated without page reload through
awaiting payment, received, preparing, out for delivery and delivered. The
unpaid order was excluded from Kitchen. A 500-cent staff-API cash settlement
and Kitchen web-UI preparation/ready swipes led to persisted completion.
Independent database checks confirmed delivered items and the expected cash
amount with no external payment ID. No browser runtime error or checked backend
traceback/HTTP 5xx was observed. The order, items and payment were removed;
tenant configuration and shared order 147 remained unchanged.

No external payment, email, provider dispatch or sandbox webhook was generated.
This verifies the cash-supported path, not online card checkout/webhooks, the
staff cash modal, courier assignment or mobile layout. Evidence:
`tmp/phase3-delivery-cash-lifecycle.json`,
`tmp/phase3-delivery-cash-cleanup.json` and
`tmp/phase3-delivery-cash-log-summary.json`.

## Reservations: live booking and cancellation pass

A dedicated synthetic tenant passed availability/slot selection, public booking
creation and confirmation, token-based view, staff UI/API visibility, public
cancellation and persistence after reload. Staff visibility reflected both booked
and cancelled states. No browser runtime errors or checked backend traceback/
HTTP 5xx occurred. Email was omitted, reminders disabled for the fixture and no
real administrator recipient was present. The reservation and all owned tenant,
staff, table, floor and location rows were removed; shared order 147 was unchanged.

Evidence: `tmp/phase3-reservations-ui-final.json` and
`tmp/phase3-reservations-cleanup-final.json`. Notification delivery, rescheduling,
seating/no-show, overbooking/concurrent requests and mobile layout were not
exercised by this browser run.

## SaaS console: scoped read-only pass

The VPS console displayed dedicated trialing/Pro and past-due/Lite fixtures.
Search, status/plan/overdue filters and conflicting-filter empty results passed,
as did the empty billing-history dialog and owner denial of operator APIs/UI.
Browser interception constrained every list request to the unique fixture marker
before transmission; global metrics were replaced with empty synthetic responses
and were not verified. No real customer billing data or lifecycle writes were
requested. All dedicated tenants/users and automatically created locations were
removed; provider IDs remained empty.

Production paywall enforcement was disabled and stayed disabled. Seeded trial
state is not proof of trial activation. Checkout, provider subscriptions,
proration, invoice payment, cancellation and webhooks were not exercised.
Enabled trial/paywall browser behavior requires the separate isolated rehearsal
now in progress. Evidence: `tmp/phase3-saas-subscriptions-ui-evidence-20260908.json`.
