# Customer QR tracking and own-item payments

## Customer behaviour

- Rescanning the same QR in the same browser restores the customer's orders using the persisted browser session. Reloading or opening another tab in that browser must not rotate that identity.
- A different browser, private browsing session, or cleared browser storage does not recover the original customer's orders. The public QR alone is not permission to view another customer's order details.
- Tracking is bounded to the current QR assignment and the latest 50 orders owned by that browser session. Reassigning an ordering point must not expose orders from its previous assignment.
- Paid orders remain trackable while preparing, ready, and completed. Payment and food preparation are separate states.
- Tracking shows only the customer's items within a shared order. Server-side ownership checks are authoritative; real-time notifications trigger a fresh scoped read rather than granting access to their payloads.
- An offline cache may retain tracking for up to 24 hours, bound to the same session and assignment. It must be visibly marked stale, must not imply current status, and must refresh after reconnection. Cached data is not payment authority.

## Payments and staff fallbacks

- Customers can use Stripe to pay for their own eligible unpaid items. Item ownership and payable amounts are determined by the server, not by customer-supplied totals or item selections.
- Durable guest payment attempts reserve the checkout and support idempotent settlement. Staff must not collect, alter, void, or remove reserved/captured lines through ordinary order-edit controls.
- A customer's successful payment does not mean the entire shared order is paid. Shared prepayment releases the order to the kitchen only when the whole required balance is settled; do not promise per-customer partial kitchen release.
- Discounts, tips, existing unallocated amount payments, incompatible whole-bill checkouts, or uncertain payment state can require staff assistance. Do not bypass those blocks by changing browser sessions, unmarking paid, or starting another provider checkout.
- Refund events requiring reconciliation are flagged for staff. The captured ledger is not silently discarded, and affected items must not become automatically repayable. This is not a claim that refunds are fully reconciled automatically.
- SMS notifications are separate from QR tracking and are not part of this acceptance.

## Acceptance checklist

Live evidence is **pending**. Check results must be recorded by the release owner; this document does not certify deployment or successful payments.

- Same-browser QR rescan and new-tab navigation restore a paid/preparing order without relying on cached order records.
- A separate browser cannot see the first customer's order ID, private notes, items, or payment credentials through the UI or API.
- Changing the QR assignment prevents access to previous-assignment orders and invalidates their cached tracking.
- Offline tracking visibly becomes stale; reconnection refreshes the authoritative status. Completed orders remain visible within the retention limits.
- Guest payment totals include only owned eligible items. Repeated confirmation/webhook delivery creates one ledger settlement, not another charge.
- Staff collection, line edits, unmark-paid, voiding, and alternate-provider checkout cannot bypass reserved or captured guest payments.
- Shared prepayment does not release early; blocked discount/tip/unallocated-payment cases direct the customer to staff.
- Refund/reconciliation states do not automatically enable another payment.

The synthetic rescan smoke uses an isolated tenant, a fixture-created paid order, and no payment provider calls. It verifies tracking, not actual Stripe capture, refund, physical printing, or customer checkout submission. Separate authorized sandbox payment checks are required before claiming the payment flow verified. Never charge a live customer as part of an unapproved smoke test.

## Deployment and recovery

- Apply `20260927120000_guest_payment_attempt.sql` before serving code that uses the guest payment attempt table. Preserve the table and its rows during rollback: they represent durable checkout reservations and settlement history.
- If rolling back payment code, disable customer checkout first. Keep a compatible signed-webhook/settlement path available until pending attempts are settled, safely cancelled with the provider, or explicitly reconciled by staff.
- Do not deploy an older whole-order checkout implementation over unresolved guest attempts or drop their table to make a rollback succeed.
- Reconcile provider state against the application ledger before re-enabling checkout. An unavailable response is not proof that a payment failed.
- Keep API keys, webhook secrets, browser session identifiers, QR tokens, and private fixture manifests out of logs, tickets, this document, and commits.

## Evidence record

- Deployment commit: pending.
- Migration execution: first and repeated application passed on isolated PostgreSQL; production application pending deployment.
- Automated regression results: 94 backend tests and 28 subtests passed; 94 frontend tests passed; production frontend build passed with existing stylesheet-size/CommonJS warnings.
- Isolated live rescan/restore smoke and fixture cleanup: pending.
- Authorized Stripe sandbox settlement/refund regression: pending.
- Customer live-payment acceptance: not established by this change.
