# Pre-MVP: QR order tracking and SIM-phone SMS notifications

## Status

- State: FEAT - planned, not started.
- Requested: 2026-09-25.
- Priority: required before MVP/customer go-live under the newly approved scope.
- This is a separate development task, not a reopening of completed Phase 4 engineering.
- Do not interpret task creation as permission to install dependencies or send customer messages.
- Existing physical acceptance and customer payment-onboarding gates remain required.

## User request

Show customers the progress of orders placed through QR menus and optionally
notify them by SMS when food is ready, including collection from reception.
Use an Android phone with a SIM and an open-source gateway instead of a paid
SMS API provider. Add this development before the MVP; implementation has not
been started by this planning task.

## Existing foundation

- The QR menu has order/item status UI and WebSocket status-update handling in
  `front/src/app/menu/menu.component.ts` and `menu.component.html`.
- Reuse the current kitchen/bar fulfillment transitions and payment rules.
- Existing Twilio code is for WhatsApp reservation reminders, not order SMS.
- Prior engineering acceptance is documented in
  `docs/0117-phase-four-engineering-acceptance.md`.
- The live readiness tracker is
  https://docs.google.com/spreadsheets/d/1Cq9GTEMMPhpEMv0dL_g-Atx3tT-OU2aIxdciXuoDJm4/edit

These observations are planning context, not proof that the expanded flow has
passed implementation or live verification.

## Scope and behavior

1. Customer tracking: Received -> Preparing -> Ready -> Served/Collected, with
   clear cancelled/error states. Keep payment and fulfillment state distinct;
   payment must not hide an order that is still being prepared.
2. Configure the venue's fulfillment mode and collection label, such as
   Reception. Kitchen-ready does not imply reception-ready. Authorized staff
   must explicitly confirm collection readiness after the order reaches the
   collection point. Preserve existing table-service behavior.
3. Offer an optional mobile number and an explicit "Text me when ready" choice.
   No number/account/SMS is required to order or view progress. Validate numbers
   with the venue's country configuration; do not assume an existing default
   country is correct for the UK pilot.
4. Send a concise venue/order-reference/collection-location notification only
   for the opted-in order's qualifying readiness event. Do not notify separately
   for every item or reveal sensitive order details in the message.
5. Keep browser tracking working when SMS is delayed or unavailable. Recover
   authoritative status after refresh, reconnection and an interrupted network.

## Gateway approach

Preferred candidate: SMSGate (SMS Gateway for Android), with its server in a
separate private Docker service on the Scanaki VPS and a dedicated Android SIM
phone. Assess the server's database/resources against VPS capacity before
deployment; do not modify the application's database to satisfy the gateway.

- Use authenticated HTTPS and outbound device connectivity. Do not expose the
  phone's local HTTP API publicly or add router port forwarding.
- Pin reviewed application/server versions or image digests; no floating
  `latest` deployment and no host-wide dependency installation.
- Default private mode can still use the upstream push service. Evaluate and
  test SSE-only operation before claiming independence from external push
  infrastructure. Document any remaining external service dependency.
- Keep gateway credentials in approved Git-ignored environment configuration
  with restricted access, never in task files, frontend code, logs or the Sheet.
- Do not enable inbound SMS forwarding or access unrelated personal messages.
  Prefer a dedicated phone because sent SMS remains on the device.
- Use the SIM's sender number; do not promise a branded sender name or free,
  unlimited messaging. Confirm the carrier plan permits this use and respect
  its limits without SIM rotation or other restriction-evasion tactics.

Primary references (recheck supported versions during implementation):

- https://github.com/capcom6/android-sms-gateway
- https://docs.sms-gate.app/getting-started/private-server/
- https://docs.sms-gate.app/getting-started/public-cloud-server/
- https://docs.sms-gate.app/faq/general/

## Reliability, security and privacy

- Use a durable outbox committed with the qualifying state transition, stable
  notification identifiers and database uniqueness constraints to prevent
  duplicate enqueueing across retries, staff double-clicks and restarts.
- Model queued, submitted, sent, delivered (when confirmed), failed, expired
  and uncertain outcomes separately. Gateway acceptance is not delivery proof.
- Check the gateway's real idempotency/status-query behavior. Reconcile
  uncertain submissions rather than blindly sending again; do not promise
  exactly-once carrier delivery when it cannot be guaranteed.
- Apply bounded retries/backoff and message expiry. Suppress pending alerts
  for cancelled, collected or superseded readiness states. Do not deliver a
  stale "ready" alert after collection merely because the phone reconnects.
- Restrict notification actions/settings and delivery callbacks to the correct
  tenant and authorized actors. Authenticate and replay-protect callbacks.
- Customer tracking links must enforce order/session authorization. A shared
  table QR or sequential order ID must not expose another customer's phone,
  notification settings or private tracking data.
- Store only necessary recipient/notification data, mask logs, and define
  retention and access controls. Keep message text transactional, not marketing.
- Surface phone offline, SMS failure and queue-age warnings to staff without
  blocking order placement, payment or kitchen fulfillment.

## Development sequence

1. Implement customer tracking and explicit reception/collection readiness.
2. Add optional notification preferences and the durable outbox with a fake
   transport for automated tests.
3. Integrate and deploy the private gateway; register the authorized SIM phone.
4. Test the complete deployed flow, including failure/recovery, then update
   this task and the tracker with evidence and any remaining operator checks.

Use up to three disjoint investigators only where useful. The primary engineer
owns integration, scoped Git operations and deployment. Preserve current phase
evidence, protected production release checks and unrelated user changes.

## Acceptance criteria and required tests

- [ ] QR customer sees correct order/item progress after submission, payment,
      refresh and WebSocket reconnect without seeing another customer's data.
- [ ] Table service and reception collection use the correct labels and trigger;
      partial item readiness never falsely declares the whole order collectable.
- [ ] Optional phone/notification selection and validation work; no selection
      produces no SMS, and checkout still succeeds when the gateway is offline.
- [ ] Backend tests cover authorization, tenant isolation, duplicate events,
      transactions, cancellation/collection suppression and safe migrations.
- [ ] Outbox/gateway tests cover offline phone, restart, timeout ambiguity,
      duplicates, expiry, failed delivery and authenticated callback handling.
- [ ] Relevant frontend build/tests and Puppeteer tracking/staff-flow checks pass.
- [ ] VPS Docker deployment, public app access and affected service/compiler logs
      are clean; gateway exposure and credential handling are checked.
- [ ] One explicitly authorized real SMS reaches the designated test recipient
      from the chosen SIM after an isolated synthetic order is marked ready.
      Confirm receipt; do not equate an API response with customer delivery.
- [ ] Phone background/locked-screen behavior and disconnect/reconnect recovery
      are tested with the actual device; delayed messages are not misleading.
- [ ] Test fixtures are cleaned up without changing real customer orders,
      payment settings or unrelated messages.
- [ ] Verified changes are committed/pushed to development, promoted through
      protected production checks when needed, deployed and live-tested.
- [ ] Evidence is recorded in the readiness Sheet before this task closes.

## Operator prerequisites to collect together

- Dedicated Android phone/model and active SIM, mobile network/plan suitability,
  intended sender ownership, power, mobile signal and internet availability.
- Approval when gateway/dependency installation is actually needed; necessary
  Android SMS/background permissions, without silently weakening device security.
- Designated test recipient and explicit permission for the real test SMS.
- Venue's collection location and who confirms reception readiness; use
  Reception as the proposed pilot label until the venue confirms it.

These prerequisites do not prevent implementing provider-independent tracking
and automated tests. They do prevent claiming the live SMS gate has passed.

## MVP closure rule

The original Phase 4 engineering result remains valid for its original scope.
After this user-approved addition, MVP sign-off also requires this task to pass,
alongside physical printing, spare NFC write/read, camera/printed-QR, venue
Wi-Fi recovery and customer live-payment acceptance. Keep recurring backups
running throughout; do not execute live rollback or real payments as part of
SMS testing.
