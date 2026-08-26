# Scanaki live incident runbook

This runbook is for the Scanaki platform operator and The Yew Trees pilot manager. Customer safety, payment accuracy and avoiding duplicate kitchen work take priority over keeping checkout open.

## First response

1. Record the time, venue/location, table/room, order number and reporter.
2. If payment or routing accuracy is uncertain, pause only the affected location. Pause the tenant only when the impact is tenant-wide.
3. Do not ask anyone to paste passwords, Stripe secrets, card data or database exports into chat.
4. Preserve the order, Stripe event and application logs. Do not delete the order to hide an incident.
5. Tell the venue whether customers may continue browsing, ordering or only pay at the bar.

## Duplicate kitchen order

1. Compare Scanaki order ID, Stripe PaymentIntent ID and table/room.
2. If both cards reference one Scanaki order, prepare it once and keep the duplicate evidence.
3. If two paid orders exist, ask the customer/manager which order is valid before refunding.
4. Record the duplicate webhook/idempotency evidence and run payment reconciliation.

## Payment succeeded but order is missing from KDS

1. Confirm the PaymentIntent succeeded in the tenant Stripe account.
2. Confirm tenant/location metadata matches the order.
3. Check the signed webhook delivery and Scanaki response.
4. Check the KDS station filter, location filter, heartbeat and connectivity.
5. Reconcile/release only through the approved idempotent recovery path; never create a replacement order manually without linking the payment.

## Failed or cancelled payment appears in KDS

1. Pause the affected location.
2. Do not prepare the order.
3. Capture the order ID, payment state and KDS card evidence.
4. Reconcile payment state and remove the unpaid order through the supported cancellation path.
5. Keep ordering paused until a failed-payment regression test passes.

## Refund request

1. Confirm the requester and manager authority.
2. Verify the order, amount, payment account and preparation status.
3. Apply the approved venue refund policy.
4. Refund through Stripe and verify Scanaki receives the signed refund event.
5. Record the reason, amount, operator and customer outcome.

## Kitchen tablet or KDS offline

1. Keep the KDS tab visible and reconnect power.
2. Check Wi-Fi, then switch to the approved SIM/mobile-data connection.
3. Reload KDS and verify the heartbeat becomes current.
4. Confirm existing paid orders are visible before resuming checkout.
5. Use paper/manual continuity only under the venue manager’s control; reconcile all orders afterwards.

## Stripe unavailable

1. Pause affected ordering; browsing may remain available.
2. Do not mark an order paid based on a customer screenshot.
3. Check Stripe status and Scanaki payment reconciliation.
4. Resume only after a low-value sandbox or approved live check completes successfully.

## Incorrect plaque/table assignment

1. Disable ordering for the affected point or pause its location.
2. Close any active table session/order before moving the plaque.
3. Reassign through Scanaki so hidden table access rotates.
4. Scan QR and tap NFC at the physical position; verify the location and room/table label.
5. Confirm the old basket/session is rejected before resuming.

## Lost or stolen tablet

1. Revoke the kitchen device and staff session.
2. Change the affected account password and increment/revoke tokens.
3. Report the SIM/device to the mobile provider and enable remote wipe when configured.
4. Register the replacement tablet as a new kitchen device; never reuse copied browser data.

## VPS or application outage

1. Check `scanaki.uk`, `/api/health`, container state, disk and TLS.
2. Review only Scanaki containers; do not restart or modify unrelated VPS workloads.
3. Restart the smallest affected Scanaki service.
4. If recovery requires deployment, take an encrypted backup before migrations.
5. After recovery, verify landing, API, login, public menu, webhook and KDS.

## Escalation evidence

Provide:

- incident start/end time and timezone;
- tenant, location and ordering point;
- Scanaki order ID and masked Stripe identifiers;
- observed/expected behaviour;
- affected customer count and payment total;
- relevant log timestamps (not secrets);
- actions taken and current ordering state.

## Closure

An incident closes only when payment/order data is reconciled, customer and venue outcomes are recorded, the failing flow passes a regression test, and any temporary pause is intentionally removed.

