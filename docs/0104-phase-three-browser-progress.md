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

## Customer account UI: partial pass, navigation defect open

Both local and VPS actual-form checks passed one synthetic customer login,
verified identity, empty order history, logout, cookie removal and subsequent
HTTP 401 denial for customer identity/orders. Fixtures were removed and no
registration or email request was sent.

After logout, fresh navigation to `/customer` incorrectly reaches staff `/login`
instead of `/customer/login`. The protected home remains inaccessible; this
observed failure is portal navigation, not an access bypass. The authentication
interceptor's initial route selection and generic staff refresh are suspected;
root-cause investigation and a focused correction are still required. Evidence:
`tmp/phase3-customer-account-ui-evidence-20260908.json`.

Loyalty enabled-state enrollment/earning/redemption work is separate and must not
be marked passed from the earlier disabled-state UI/404 check. Reservation,
delivery, subscription and group end-to-end acceptance also remain open. The
approved final physical session is unchanged; no Phase 3 completion or go-live
is declared here.
