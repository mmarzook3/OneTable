# One Table MVP: open-source baseline and required modifications

**Status:** Core MVP implemented and locally validated; venue hardware and production launch inputs remain

**Product:** One Table, operated under the Fixaki brand

**Founding pilot tenant:** The Yue Tree Pub

**Baseline:** Satisfecho POS, AGPL-3.0, `development` commit `c3334fc6c`

**Review date:** 2026-08-23

## 1. Purpose

This document records:

1. What is already present in the imported Satisfecho open-source application.
2. What must be changed to produce the One Table MVP.
3. Which changes block a live pilot at The Yue Tree Pub.
4. Which existing Satisfecho features will be hidden or deferred to keep the MVP small.

This began as the source-code assessment for the fork. The core MVP described below has now been implemented and exercised in Docker. Sections 4–6 preserve the original gap analysis; the completion record below and the checklist in section 7 distinguish finished software from venue-controlled launch work.

## 2. Locked MVP decisions

| Decision | One Table MVP choice |
|---|---|
| Licence | AGPL-3.0 for the MVP; provide a visible source-code offer/link to the corresponding One Table source |
| First tenant | The Yue Tree Pub |
| Customer installation | None; responsive browser menu opened by QR or NFC |
| Kitchen installation | Responsive tablet browser for this milestone; packaged Android/PWA installation is explicitly deferred to the final Android phase |
| Ordering model | Dine-in, table-specific, payment required before kitchen release |
| Table access | Permanent QR and NFC plaque; no staff activation required for The Yue Tree |
| Remote access | Menu may be viewed remotely; ordering is controlled by service availability, payment, rate limits and optional risk checks |
| Payments | Stripe; the tenant receives its customer payments |
| Kitchen order | Created/released to the kitchen only after server-side payment confirmation |
| Kitchen queue | FIFO by paid time, oldest order first; an optional explicit urgent override may be retained |
| Tenant onboarding | Manual for the pilot; self-service subscriptions are not required |
| Hosting | Docker deployment on a VPS after local verification |

### Implementation completion record — 2026-08-23

Implemented and locally validated:

- Multi-tenant One Table/Fixaki branding and a visible AGPL source link.
- The Yue Tree Pub pilot tenant, 12 naturally ordered tables, a kitchen station, GBP/Europe-London policy, pilot accounts and a clearly labelled ten-item acceptance menu.
- Automatic QR/NFC ordering without staff table activation, with service-hours, emergency-pause and kitchen-heartbeat gates.
- Canonical per-table URLs, high-error-correction QR PNGs, a bulk printable plaque PDF, token rotation, plaque lifecycle state and Web NFC writing/read-back with copy fallback.
- Mandatory table confirmation, retry-safe public checkout, immutable payment snapshots and Stripe as the only prepayment path.
- Encrypted per-tenant Stripe secrets, tenant-key and Connect modes, signed per-tenant webhooks, idempotent release, failure/cancellation/refund states and reconciliation monitoring.
- Payment-confirmed-only KDS visibility, strict FIFO by kitchen release time, touch-sized Start/Ready/Complete controls, timers, reconnect banner, heartbeat and screen wake lock.
- Docker/VPS preflight, encrypted database backup, isolated restore validation, health monitoring and a Yue Tree pilot runbook.

Validation evidence:

- 451 backend tests pass.
- The optimized Angular browser/server build succeeds.
- Browser acceptance passed for mobile menu, automatic checkout gating, admin settings/table tools, and the Android-tablet-sized FIFO kitchen flow.
- A real HMAC-formatted Stripe webhook acceptance exercise released one order exactly once; the unpaid order was absent from KDS before payment.
- Encrypted backup creation and restore into an isolated temporary database passed with 66 schema tables.

Not software blockers, but still required for production: the final domain/TLS, real Stripe account credentials, venue-approved menu/allergens/policies, physical NFC/QR prototypes, and testing on the chosen kitchen tablet. The Android application remains excluded from this milestone by explicit product decision.

## 3. Current open-source architecture

The imported application is a multi-service web application:

```text
Customer/staff browser
        |
        v
Angular frontend
        |
        v
HAProxy --> FastAPI backend --> PostgreSQL
                    |
                    +----------> Redis
                    |               |
                    +----------> WebSocket bridge
```

The repository includes Docker Compose configurations for development and production. The main technologies are Angular, FastAPI, SQLModel, PostgreSQL, Redis, WebSockets and HAProxy.

## 4. Current capability assessment

### 4.1 Tenants, users and platform operation

#### Existing

- Tenant-scoped restaurant data.
- Owner/admin/staff users with role and permission checks.
- Kitchen and bartender roles.
- Platform-operator portal for viewing tenants and activity.
- Guided restaurant signup.
- Optional SaaS trial/subscription paywall.
- Restaurant groups and multi-location sharing options.
- Per-tenant currency, timezone, language and business settings.
- Per-tenant public background colour, logo and header image.

#### One Table modifications

- Replace Satisfecho, POS2 and Amvara public branding with One Table and Fixaki branding.
- Replace upstream domains, SEO content, email copy, public footer content and support links.
- Add the required AGPL source-code link to public and authenticated application surfaces.
- Simplify the platform portal around One Table tenants, locations, tables, payment state and kitchen connectivity.
- Keep tenant creation manual for the Yue Tree pilot.
- Keep the existing SaaS paywall disabled during the pilot.
- Add explicit tenant feature flags so irrelevant modules can be hidden without deleting upstream code.
- Repeat tenant-isolation tests for every new One Table endpoint and data model.

### 4.2 Menu and product administration

#### Existing

- Product and category management.
- Product images and descriptions.
- Prices, tenant currency and tax configuration.
- Product availability controls.
- Product customisation questions: single choice, multi-select, scale and text.
- Customer and order-level notes.
- Promotion rules and discounted menu prices.
- Kitchen/bar station mapping.
- Menu translations and multiple interface languages.

#### One Table modifications

- Create a simplified pub-focused menu editor and onboarding path.
- Confirm GBP display, UK tax settings and receipt behaviour.
- Add or verify explicit allergen fields and customer-facing allergen guidance.
- Add an alcohol flag, an age-confirmation step and a visible fulfilment age-check indicator; final operational wording must be approved by the venue.
- Add modifier price adjustments if the Yue Tree menu needs paid extras; the current customisation system does not implement per-option price deltas.
- Add quick sold-out and back-in-stock actions suitable for a busy service.
- Import the Yue Tree menu from a structured spreadsheet or CSV rather than entering every item manually.

### 4.3 Tables and table allocation

#### Existing

- Create, update and delete tables.
- Table name/number, floor, seat count, shape, position and rotation.
- Visual floor-plan canvas.
- Table grouping/joining.
- A unique UUID token automatically generated for each table.
- Tenant ownership is taken from the authenticated user rather than accepted from the client.
- Public menu route: `/menu/{table_token}`.
- A QR code is rendered for each table.
- Staff can copy the public menu link.
- Table activation and rotating four-digit PIN controls.

#### One Table modifications

- Add bulk creation such as `Table 1` through `Table 20`.
- Add a tenant ordering mode:
  - `automatic` — no staff activation or PIN; used by The Yue Tree.
  - `activation_pin` — preserve the upstream security flow for tenants that want it.
  - `menu_only` — browsing allowed but checkout disabled.
- In automatic mode, calculate ordering availability from service hours, tenant pause state and kitchen-display connectivity.
- Add an emergency **Pause ordering** control.
- Add explicit token rotation/revocation for lost, stolen or replaced plaques.
- Keep the table token stable when a table is renamed so existing plaques remain valid.
- Add a plaque status such as `not_created`, `printed`, `nfc_written`, `tested`, `active` or `revoked`.
- For the MVP, one plaque may map directly to one table token. Introduce a separate plaque/access-point table later only if multiple plaques per table or reassignment history is needed.

### 4.4 QR-code lifecycle

#### Existing

- The table screen renders a QR code in the browser using the permanent table-menu URL.
- The current QR uses medium error correction and includes the table name below it.
- The menu link can be copied.

#### One Table modifications

- Use the One Table production host rather than `window.location.origin` as the canonical plaque host.
- Add an access-source marker:

  ```text
  QR:  https://<one-table-host>/menu/{token}?via=qr
  NFC: https://<one-table-host>/menu/{token}?via=nfc
  ```

- Generate downloadable PNG and SVG files per table.
- Generate a printable PDF/contact sheet for all tables in a tenant.
- Add high error correction and validate minimum size, quiet zone and contrast for physical printing.
- Include tenant name, table number, One Table identity and “Scan or tap to order” text in the plaque artwork.
- Add a **Test link** action before marking a plaque active.
- Add bulk plaque export for the 3D-printing workflow.
- Record QR versus NFC entry analytics without storing unnecessary customer-identifying data.

### 4.5 NFC lifecycle

#### Existing

- No NFC, NDEF, NTAG or tag-management implementation was found in the imported application.

#### One Table modifications

- Add **Write NFC** to the table/plaque administration screen.
- Write the table's HTTPS URL as an NDEF URL record.
- Support Web NFC on compatible Android Chrome devices.
- Provide **Copy NFC URL** as a fallback for a separate NFC-writing application.
- Verify the written tag by reading it back where the browser supports this.
- Record who wrote the tag and when, without treating the NFC hardware UID as the public identity.
- Do not make pilot tags permanently read-only until the production domain and full flow are verified.
- After final verification, allow the operator to mark a tag as locked/read-only and warn that the action is irreversible.
- Document the physical requirement for an on-metal/ferrite-backed tag when the plaque is installed against metal.

Proposed plaque workflow:

```text
Create tables
    -> generate QR artwork
    -> print three prototype plaques
    -> write NFC URL from Android
    -> verify QR and NFC on multiple phones
    -> seal NFC inside plaque
    -> mark plaque active
    -> print remaining plaques
```

### 4.6 Customer ordering

#### Existing

- Responsive public menu opened from a table token.
- Basket/cart, product questions, notes and order history.
- Browser session identifiers.
- Shared table cart for activated dine-in tables.
- WebSocket updates.
- Optional location-risk flagging.
- Optional setting named `immediate_payment_required`.
- Stripe and Revolut customer payment interfaces.

#### One Table modifications

- Remove the mandatory activation/PIN gate when the tenant uses automatic ordering.
- Display the tenant and table prominently before checkout.
- Add a mandatory confirmation such as “I am ordering for Table 12”.
- Make Stripe payment the only customer payment method for the Yue Tree MVP.
- Show clear service-closed, ordering-paused and kitchen-offline states.
- Allow browsing when ordering is unavailable.
- Add a retry-safe payment recovery screen if the browser closes or loses connection.
- Add a customer receipt/confirmation path and an operator-approved cancellation/refund message.
- Keep browser geolocation optional; it may be used for risk scoring but must not be the only method customers rely on.

### 4.7 Stripe and payment integrity

#### Existing

- Per-tenant Stripe publishable and secret-key fields.
- Stripe PaymentIntent creation.
- Server retrieves the PaymentIntent and validates its status, order metadata and amount when the browser calls the confirmation endpoint.
- Payment rate limiting.
- Separate Stripe subscription webhook support exists for the platform SaaS paywall.
- Guest-order Stripe webhooks do **not** exist.
- Tenant Stripe secret keys are stored directly on the tenant model and masked only when returned by the settings API.

#### Critical current problem

The current table flow creates a pending order, commits it and publishes a `new_order` WebSocket event **before payment**. The kitchen display includes pending orders. The optional immediate-payment setting opens checkout after the order already exists; it does not enforce payment-before-kitchen.

The current successful-payment path depends on the browser calling `/orders/{id}/confirm-payment`. If the customer pays but closes the browser before this call, the server may not mark the order paid promptly. This is unsuitable for the One Table live pilot.

#### One Table modifications — live-pilot blockers

- Introduce a quote or unpaid-checkout record that is not visible to the kitchen.
- Create the Stripe payment from a server-calculated, immutable amount snapshot.
- Add Stripe idempotency keys for checkout/payment creation.
- Implement a signed Stripe guest-payment webhook as the source of truth.
- Validate payment status, amount, currency, tenant, order/quote reference and metadata in the webhook.
- Atomically create or release the kitchen order only after `payment_intent.succeeded`.
- Publish `new_order` only after that transaction commits.
- Make duplicate webhook delivery safe and prevent duplicate orders.
- Handle payment failure, cancellation, expiration and refunds explicitly.
- Prevent menu/price changes from changing an already-created payment quote.
- Add reconciliation tooling for paid Stripe intents that have no released order.
- Add automated tests proving failed, cancelled and unpaid attempts never appear on kitchen/bar displays.

#### Stripe-account approach

- **Local/test validation:** the existing per-tenant test keys may be used temporarily.
- **Target live architecture:** Stripe Connect with a connected Yue Tree account and direct charges, so customer funds go to the venue.
- If Connect is deferred for the pilot, tenant secret keys must at minimum be encrypted at rest, access-controlled and rotatable before live use. Plain database storage is not an acceptable final live configuration.

### 4.8 Kitchen and bar display

#### Existing

- Full-screen `/kitchen` and `/bar` routes.
- Authenticated role/permission protection.
- Large order cards with table, items, notes and customisations.
- Polling every 15 seconds plus WebSocket refresh.
- Optional new-order sound.
- Live waiting timers with configurable green/yellow/orange/red thresholds.
- Orders sorted by urgency first, then oldest `created_at` first.
- Item transitions: pending -> preparing -> ready -> delivered, including backward correction.
- Kitchen/bar station routing and station filter.
- Finished/delivered lines leave the active view.

#### One Table modifications

- Change the queue timestamp from order creation to confirmed paid/released time.
- Default to strict FIFO, oldest paid order on the left; make urgent override an explicit tenant option.
- Adjust the landscape layout to match the agreed expeditor-style reference: dense columns, visible timers and clear paid/table headers.
- Replace small dropdown interactions with large touch targets for Start, Ready and Complete/Delivered.
- Add optional order-level actions while preserving item-level station actions.
- Ensure only payment-confirmed orders can enter the active list.
- Add a persistent offline/reconnecting banner.
- Add an online heartbeat from each kitchen device.
- Stop new checkout automatically when the tenant requires a kitchen device and no device heartbeat is recent.
- Add a device-management screen with device name, station, last seen time and revoke action.
- Add kiosk/full-screen guidance, screen wake-lock handling and automatic reconnection.
- Run a full-shift soak test on the actual Yue Tree Android tablet.

### 4.9 Android installation — deferred final phase

#### Existing

- The kitchen display is a responsive authenticated web route.
- Fullscreen support exists in the component.
- No PWA manifest, service-worker installation path, Capacitor project or Android APK packaging was found.

#### Future Android-phase modifications

- Make the kitchen interface an installable PWA for the MVP.
- Add application manifest, One Table icons, theme colours and standalone display mode.
- Add an installation guide and “Install kitchen app” prompt for compatible Android browsers.
- Persist the selected tenant/station and restore the kitchen screen after restart.
- Avoid caching live order responses as authoritative offline data.
- Add an in-app version indicator and update/reload prompt.
- Consider a Capacitor APK only if PWA kiosk, sound or device-management behaviour is insufficient in the pilot.

### 4.10 Service availability and automation

#### Existing

- Tenant opening-hours settings.
- Table activation/PIN availability gate.
- Optional location-risk flagging.
- Rate limits backed by Redis.
- Staff can manage items and orders.

#### One Table modifications

An automatic table is allowed to check out only when all mandatory conditions pass:

```text
Tenant active
AND within configured food/drink service hours
AND ordering not manually paused
AND required kitchen/bar station online
AND basket still valid and available
AND Stripe payment succeeds
```

- Add tenant-specific food and drink service schedules rather than relying only on general venue opening hours.
- Add tenant-wide and station-specific pause controls.
- Add a kitchen-device heartbeat timeout, initially two minutes.
- Surface the exact unavailable reason to staff, but use simple customer-facing wording.
- Preserve optional location and IP checks as risk signals rather than guaranteed proof of physical presence.

### 4.11 Deployment, monitoring and recovery

#### Existing

- Docker Compose development and production configurations.
- PostgreSQL, Redis, HAProxy and WebSocket bridge.
- Health and database-health endpoints.
- Migration scripts.
- Rate limiting and a documented security review.
- Printing agent and broader operational modules that are not needed for the pilot.

#### One Table modifications

- Create One Table-specific environment examples without real secrets.
- Remove assumptions about the upstream production host and certificates.
- Configure the final One Table domain, HTTPS, CORS and WebSocket URL.
- Add automated encrypted database backups and a tested restore runbook.
- Add uptime monitoring, exception reporting and payment/order reconciliation alerts.
- Add log retention without payment secrets or unnecessary personal data.
- Add separate staging/test and production Stripe configuration.
- Add a deployment runbook for the selected VPS.
- Add an emergency rollback procedure.
- Complete dependency audits and a focused security review before live payments.

## 5. Features to hide or defer

The following upstream modules should be hidden by feature flags for the Yue Tree MVP, not removed immediately:

- Reservations and waiting list.
- Delivery and courier portal.
- Provider/supplier marketplace.
- Full inventory and multi-warehouse management.
- Staff contracts, shifts and working plan.
- Club loyalty and birthday/referral features.
- Social posting tools.
- Spanish VeriFactu and German TSE fiscal integrations.
- Complex billing-customer/Factura workflows.
- Restaurant-group catalogue sharing.
- Hardware printing unless the Yue Tree specifically requires it.
- Platform self-service subscriptions and public pricing.
- Public Satisfecho marketing/about pages.
- Voice navigation and promotional-video tooling.

Keeping these modules disabled reduces navigation, support and test scope while allowing selected upstream improvements to be retained.

## 6. MVP implementation priority

### P0 — required before accepting live customer payments

1. Run and audit the unmodified stack locally.
2. One Table/Fixaki branding and AGPL source offer.
3. Yue Tree tenant, staff roles and menu import.
4. Automatic ordering mode and service/pause rules.
5. Payment-before-kitchen redesign with signed Stripe webhook and idempotency.
6. Secure Stripe-account integration and secret handling.
7. QR download/print and NFC write/verify workflow.
8. FIFO kitchen touch layout and payment-confirmed filtering.
9. Responsive tablet KDS, reconnect state, wake lock and kitchen heartbeat; Android packaging is deferred.
10. Production deployment, backups, monitoring and security checks.
11. End-to-end test on real phones, Stripe test mode and the Yue Tree tablet.

### P1 — desirable during or immediately after the pilot

- QR/NFC access analytics.
- Bulk plaque PDF and manufacturing export improvements.
- Device-management dashboard.
- Modifier price deltas.
- Refund and reconciliation dashboard.
- Bar-specific tablet if the pilot uses separate kitchen and bar stations.
- Optional tenant-configurable location-risk checks.

### P2 — after MVP validation

- Self-service tenant signup and One Table subscriptions.
- Google Play or managed APK distribution.
- POS integration.
- Stock management and automated purchasing.
- Loyalty and customer accounts.
- Delivery/collection channels.
- Advanced reporting and multi-location management.

## 7. Definition of done for the Yue Tree pilot

The MVP is ready for a controlled live pilot only when all of these are demonstrated:

- [ ] Staff can create or import the Yue Tree menu and mark an item sold out.
- [x] Staff can bulk-create tables and download a correctly labelled QR for each one.
- [ ] An Android device can write and verify each table's NFC URL.
- [x] QR and NFC open the same tenant/table menu.
- [x] Renaming a table does not break its plaque.
- [x] Revoking/rotating a plaque prevents the old link from placing orders.
- [x] Automatic ordering requires no table activation or PIN.
- [x] Service hours, pause state and kitchen heartbeat correctly gate checkout.
- [x] A failed, cancelled or abandoned payment never appears in the kitchen.
- [x] A successful Stripe webhook creates exactly one kitchen order.
- [x] Duplicate Stripe webhook delivery does not create a duplicate order.
- [x] Kitchen cards display strict FIFO order from oldest paid time.
- [ ] Kitchen sound, timers and touch actions work on the Yue Tree tablet.
- [ ] The kitchen app reconnects after Wi-Fi loss and clearly shows offline state.
- [x] Tenant A cannot read or modify Tenant B tables, menu, orders, devices or payments.
- [x] Database backup and restore have been tested.
- [ ] A complete test-mode order, refund and reconciliation exercise has passed.
- [ ] At least three physical QR/NFC plaque prototypes pass multi-phone testing.
- [x] The application provides the required AGPL source-code link; production-domain verification remains part of deployment.
- [ ] The venue has approved menu, allergen, alcohol and customer-support wording.

## 8. Expected implementation sequence

| Stage | Work | Indicative effort |
|---|---|---:|
| 0 | Docker setup, boot, migrations and baseline smoke tests | 1–3 days |
| 1 | Branding, feature flags and Yue Tree tenant/menu setup | 2–4 days |
| 2 | Automatic ordering, tables, QR export and NFC workflow | 3–6 days |
| 3 | Stripe payment-before-kitchen, webhook and reconciliation | 5–10 days |
| 4 | FIFO kitchen refinements, tablet browser and heartbeat | 4–7 days |
| 5 | Deployment, security, backups, device and venue testing | 5–10 days |

The expected calendar range remains approximately four to six weeks for one experienced full-time developer, assuming the Yue Tree menu, Stripe account, domain and Android tablet are available promptly. Findings from the first complete runtime audit may change this estimate.

## 9. Inputs required from Fixaki and The Yue Tree

- One Table and Fixaki logos, colours and preferred domain.
- Yue Tree legal/business name and customer-facing contact details.
- Table count, table labels, floors/areas and seat counts.
- Full menu, prices, product options, images and availability.
- Allergen information and approved allergy notice.
- Alcohol products and approved age-check workflow.
- Food and drink service hours.
- Whether food and drinks use one display or separate kitchen/bar displays.
- Android tablet model and Android version.
- Yue Tree Stripe account and authorised onboarding contact.
- Refund/cancellation policy and responsible staff contact.
- Confirmation of whether a receipt printer is required for the pilot.

## 10. Repository and licence handling

- One Table MVP source is hosted in `mmarzook3/OneTable`.
- `origin` is the One Table repository.
- `upstream` fetches Satisfecho changes and is configured as no-push locally.
- Routine work is committed to `development`; `master` remains the stable branch.
- Upstream changes are reviewed and selectively merged; they are never applied automatically.
- AGPL copyright and licence notices must be preserved.
- One Table modifications used by remote customers must be offered as corresponding source under AGPL.
- A future proprietary implementation must use a separate clean codebase or an appropriate commercial licence; this AGPL history remains available under AGPL.

## 11. Primary code and documentation references

- `README.md` — upstream feature overview and architecture.
- `back/app/models.py` — tenant, table, Stripe and order models.
- `back/app/main.py` — tables, public menu ordering and payment endpoints.
- `front/src/app/tables/tables.component.ts` — table management and QR rendering.
- `front/src/app/menu/menu.component.ts` — customer menu, order and payment flow.
- `front/src/app/kitchen-display/kitchen-display.component.ts` — FIFO queue, timers, sound and item actions.
- `docs/0009-table-pin-security.md` — current activation/PIN flow.
- `docs/0015-kitchen-display.md` — current kitchen and bar display.
- `docs/0031-order-customizations-plan.md` — modifiers and remaining price-delta gap.
- `docs/0052-saas-signup-paywall.md` — existing optional platform subscriptions.
- `docs/0059-platform-operator-portal.md` — current platform administration.
- `docs/SECURITY-REVIEW.md` — known security posture and guest-payment webhook gap.
