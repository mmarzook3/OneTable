# Kitchen first-swipe printing

The kitchen display requests one automatic kitchen ticket when an operator
completes the first **Swipe to Start** action for an order. Creating or loading
an order does not request printing. Swiping to Ready or Complete, refreshing the
display, and changing status through order history do not request another
automatic ticket. The keyboard equivalent of Swipe to Start has the same effect.

Automatic deduplication is enforced by the backend, not browser storage, so
multiple tablets and status reversals do not deliberately produce another
automatic copy. The status change and initial ticket enqueue must be committed
together. This is queue-level protection, not a claim of exactly-once physical
delivery under a printer or network failure.

Each active order and All orders/history entry includes a **print icon** for an
explicit manual kitchen-ticket copy. Manual printing does not change order or
payment state. The button is disabled during a request or status change and
requires order-reading permission. A later deliberate click requests another
copy, including when the previous attempt failed.

Printing uses the existing authenticated cloud queue and local LAN print agent.
An offline agent leaves the ticket queued; it does not launch a browser print
dialog as a second automatic route. Keep the venue's local agent online and
configured for the intended kitchen printer. A queue acknowledgement is not
physical proof that paper was produced.

## Acceptance checks

- New orders and refreshes produce no automatic print jobs.
- First Start swipe creates one automatic job and preserves payment state.
- Duplicate/concurrent Start requests and a later status reversal do not create
  another automatic job for the same order.
- Ready/Complete swipes and history corrections do not auto-print.
- Print icons request explicit copies without advancing status; busy and error
  handling work on desktop, mobile and Android WebView.
- Tenant/permission boundaries and concurrent print-agent claims remain safe.
- Deploy through protected release checks and test the actual VPS queue, local
  print agent and physical printer. Leave two labelled unpaid test orders in
  New state for the operator; do not print them during fixture creation.

Frontend/backend tests, compiler logs, deployed SHA and physical results must be
recorded before declaring this change verified. Existing test orders must not
be removed or reset without the operator's request.
