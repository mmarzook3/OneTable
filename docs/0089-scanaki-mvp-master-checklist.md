# Scanaki MVP master checklist

Last reviewed: 26 August 2026

This is the single numbered checklist for taking Scanaki and The Yew Trees pilot from the current state to a controlled live MVP. Refer to an item by its permanent ID, for example: **“Fix `MVP-009`.”**

## How to use this checklist

- Do not renumber existing IDs.
- Change `[ ]` to `[x]` only when the completion condition has been verified.
- Add a short evidence note beneath the item when it is completed: commit, test result, screenshot, Stripe event, invoice, or signed venue approval.
- `P0` blocks the first supervised pilot shift.
- `P1` blocks public launch or safe ongoing operation.
- `P2` is needed before selling Scanaki broadly.
- `Deferred` is intentionally outside the Yew Trees MVP.

## Recommended execution order

1. `MVP-001`–`MVP-008`: deployment, platform configuration and security.
2. `MVP-009`–`MVP-016`: payment, kitchen tablet and physical plaque acceptance.
3. `MVP-036`–`MVP-067`: finish The Yew Trees data, menu, policies and training.
4. `MVP-076`–`MVP-088`: execute and sign off the complete pilot acceptance test.
5. `MVP-018`–`MVP-035`: finish platform operations and commercial SaaS readiness.

---

## A. Scanaki critical pilot blockers

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-001 | [x] | P0 | Scanaki | Deploy the latest `development` release to the VPS. | Production serves commit `263249c3c` or a later approved commit and health checks return 200. |
| MVP-002 | [x] | P0 | Scanaki | Apply the smart-plaque request migration during deployment. | Production schema includes migration `20260826013000`; pre-deploy backup and post-deploy health checks pass. |
| MVP-003 | [x] | P0 | Scanaki | Complete the Platform Settings company and legal identity. | Company name, address, phone, website, company number, VAT number, support/contact emails, Terms URL and Privacy URL are saved. |
| MVP-004 | [x] | P0 | Scanaki | Configure and test platform SMTP. | Google Workspace IP-authenticated relay is verified; Gmail received both the SMTP test and the platform password-reset email from `support@scanaki.uk` with valid Scanaki links. |
| MVP-005 | [ ] | P0 | Scanaki | Separate the VPS root and Scanaki platform-admin passwords. | Both have unique strong passwords stored in the approved password manager and both logins are tested. |
| MVP-006 | [ ] | P0 | Scanaki | Rotate the unrestricted Stripe test secret shared during setup. | Old key is revoked; Scanaki continues using the encrypted restricted key; webhook and PaymentIntent test pass. |
| MVP-007 | [x] | P0 | Scanaki | Remove or disable the legacy `superadmin@scanaki.uk` platform account. | Only approved named platform operators can authenticate; legacy tokens are revoked. |
| MVP-008 | [ ] | P0 | Joint | Issue fresh one-time owner and kitchen credentials. | Credentials are shared securely, first-login password change is enforced, and both accounts authenticate successfully. |

## B. Stripe sandbox and kitchen-release acceptance

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-009 | [x] | P0 | Joint | Complete one successful Stripe sandbox table order. | Paid order reaches the correct kitchen once with the correct location and table. |
| MVP-010 | [x] | P0 | Scanaki | Test failed and cancelled Stripe payments. | Neither payment appears in KDS; order states and customer messages are correct. |
| MVP-011 | [x] | P0 | Scanaki | Test duplicate successful-payment webhook delivery. | Duplicate event does not create another order, release, stock movement or kitchen card. |
| MVP-012 | [x] | P0 | Scanaki | Test sandbox refund and reconciliation. | A real test-mode refund updated the order to `refunded`; the single payment leg remained intact and the refund-aware reconciliation monitor completed without mismatch. |
| MVP-013 | [ ] | P0 | Joint | Configure the selected Android kitchen tablet. | Updated Chrome, SIM, Wi-Fi, sound, landscape mode, wake lock, rugged case and permanent charger are working. |
| MVP-014 | [ ] | P0 | Joint | Run an eight-hour tablet and connectivity test. | KDS remains responsive; Wi-Fi-to-SIM failover works; no missed or duplicate orders; battery/temperature remain safe. |
| MVP-015 | [ ] | P0 | Scanaki | Manufacture three QR/NFC prototype plaques. | Three permanent Scanaki plaque IDs are printed/embedded and recorded in inventory. |
| MVP-016 | [ ] | P0 | Joint | Complete physical QR/NFC and reassignment tests. | QR and NFC work on Android/iPhone; location/table labels are correct; reassignment works; old basket is rejected. |
| MVP-017 | [x] | P1 | Joint | Decide the outside-venue ordering policy. | Written decision approves paid remote orders or enables tested GPS/location validation without breaking hotel-room ordering. |

## C. Scanaki platform operations and reliability

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-018 | [x] | P1 | Scanaki | Add forgotten-password recovery for platform administrators. | Username-based operators have a separate recovery inbox and can request a scoped, expiring reset link without exposing account existence. |
| MVP-019 | [x] | P1 | Scanaki | Add forgotten-password recovery for customer accounts. | Customer reset email, one-time token, session revocation and UI flow pass. |
| MVP-020 | [x] | P1 | Scanaki | Add forgotten-password recovery for courier accounts. | Courier reset email, one-time token, session revocation and UI flow pass. |
| MVP-021 | [x] | P1 | Scanaki | Write the live incident and support runbook. | Runbook covers duplicate orders, refunds, kitchen outage, Stripe outage, internet failure, lost tablet and wrong plaque assignment. |
| MVP-022 | [ ] | P1 | Scanaki | Configure operational alerts. | Named recipient receives container, health, KDS, reconciliation, disk, backup and TLS-expiry alerts. |
| MVP-023 | [ ] | P1 | Scanaki | Configure encrypted off-VPS backups. | Automated encrypted copy exists outside the VPS and retention/restore ownership is documented. |
| MVP-024 | [ ] | P1 | Scanaki | Apply pending VPS OS/security updates and reboot. | Maintenance completes; all Scanaki containers, TLS, cron jobs and health checks recover successfully. |
| MVP-025 | [x] | P1 | Scanaki | Perform a production backup restore drill after deployment. | Latest encrypted backup restores into an isolated database and tenant/order checks pass. |
| MVP-026 | [x] | P1 | Scanaki | Complete the final public branding audit. | Landing, login, manuals, emails, menus, booking, KDS and errors show only approved Scanaki/Fixaki branding. |
| MVP-027 | [ ] | P1 | Scanaki | Complete mobile, touch and accessibility QA. | Supported Android/iPhone sizes pass; touch targets, contrast, keyboard access and screen-reader labels are acceptable. |

## D. Scanaki subscriptions and commercial operation

These are not blockers while The Yew Trees remains on the free internal Pilot tier.

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-028 | [ ] | P2 | Scanaki | Define the Yew Trees pilot agreement. | Duration, included support, data responsibilities, exit criteria and post-pilot pricing are approved. |
| MVP-029 | [ ] | P2 | Scanaki | Configure Scanaki’s platform Stripe billing account. | Platform customer/subscription credentials are configured separately from restaurant order-payment credentials. |
| MVP-030 | [ ] | P2 | Scanaki | Create Stripe prices for Lite, Pro, Ultra and extra tables. | Stripe price IDs match the platform pricing console and advertised GBP prices. |
| MVP-031 | [ ] | P2 | Scanaki | Configure and validate the SaaS subscription webhook. | Signup, invoice, payment failure, cancellation and renewal events are verified. |
| MVP-032 | [ ] | P2 | Scanaki | Enable the SaaS paywall after acceptance. | Trial/signup/checkout works and unpaid restaurants cannot enter paid features beyond the agreed grace period. |
| MVP-033 | [ ] | P2 | Scanaki | Test subscription lifecycle controls. | Upgrade, downgrade, proration, cancellation, suspension, grace period and grandfathering pass. |
| MVP-034 | [ ] | P2 | Scanaki | Validate subscription invoices and billing emails. | Invoice/payment history matches Stripe and emails reach the restaurant contact. |
| MVP-035 | [ ] | P2 | Scanaki | Define plaque commercial rules. | Manufacturing, delivery, replacement, damaged plaque and extra plaque prices are documented. |

---

## E. The Yew Trees business profile and locations

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-036 | [ ] | P0 | Yew Trees | Provide the pub phone number. | Number is verified and displayed in the tenant profile and customer help surfaces. |
| MVP-037 | [x] | P0 | Yew Trees | Confirm the real owner/contact email. | Inbox exists, receives Scanaki email and is approved for account recovery. |
| MVP-038 | [x] | P1 | Yew Trees | Provide company/VAT details if applicable. | Legal and invoice fields are completed or explicitly marked not applicable. |
| MVP-039 | [ ] | P1 | Joint | Approve the public description, logo and venue branding. | Owner signs off the public menu and booking header on mobile and desktop. |
| MVP-040 | [x] | P0 | Yew Trees | Confirm the pub ordering-point count. | Production contains 9 indoor tables and 8 outdoor benches under The Yew Trees. |
| MVP-041 | [x] | P0 | Yew Trees | Confirm each pub table’s seating capacity. | Indoor tables and outdoor benches are approved at four seats each. |
| MVP-042 | [x] | P0 | Yew Trees | Confirm Sports Lounge table capacities. | Eight lounge tables are created and enabled at four seats each. |
| MVP-043 | [x] | P0 | Yew Trees | Provide Premium Building room identifiers. | Thirteen Room ordering points are live as temporary identifiers `PB1`–`PB13`; the owner may later replace them with the hotel room numbers without changing plaque tokens. |
| MVP-044 | [x] | P0 | Yew Trees | Confirm Main Building rollout status. | Main Building is retained inactive with no ordering points until the venue requests it. |
| MVP-045 | [x] | P0 | Yew Trees | Approve customer-facing location names. | QR/NFC menu header, cart, payment, KDS and report all show approved wording. |

## F. The Yew Trees menu and allergens

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-046 | [ ] | P0 | Yew Trees | Approve all twenty menu products. | Owner-signed menu list matches production exactly. |
| MVP-047 | [ ] | P0 | Yew Trees | Approve every menu price. | Customer menu, Stripe amount, receipt and reports use the approved GBP price. |
| MVP-048 | [ ] | P1 | Joint | Complete customer-friendly product descriptions. | Every live product has accurate concise wording. |
| MVP-049 | [ ] | P1 | Joint | Link final product photographs. | Every live product has an approved, optimised image that loads quickly on mobile. |
| MVP-050 | [ ] | P0 | Yew Trees | Review allergen data for every product. | Every live product is marked reviewed with accurate allergens and owner sign-off. |
| MVP-051 | [ ] | P1 | Yew Trees | Confirm vegetarian, vegan and spicy tags. | Tags are accurate and filtering returns the expected products. |
| MVP-052 | [ ] | P1 | Yew Trees | Confirm product modifiers/options. | Portion, cooking, sauces, sides and notes are configured for every applicable item. |
| MVP-053 | [ ] | P1 | Joint | Decide whether paid modifier price adjustments are required. | Either price adjustments are implemented/tested or owner signs off that all modifiers are free. |
| MVP-054 | [ ] | P0 | Joint | Test kitchen Stock controls with the final menu. | Kitchen can disable/restore products and the customer menu updates immediately without losing open orders. |

## G. The Yew Trees hours, reservations and legal policies

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-055 | [x] | P0 | Yew Trees | Confirm ordering opening/closing times. | Effective ordering schedule is approved for all days and each location. |
| MVP-056 | [ ] | P1 | Yew Trees | Confirm reservation availability and capacity rules. | Booking follows opening hours with a 90-minute default table turn; party sizes, walk-in reserve and closures are configured and tested. |
| MVP-057 | [ ] | P0 | Joint | Publish Terms of Service. | Approved HTTPS Terms URL is saved in Scanaki and visible before ordering. |
| MVP-058 | [ ] | P0 | Joint | Publish Privacy Policy. | Approved UK privacy notice covers orders, payments, analytics and reservations and is linked publicly. |
| MVP-059 | [ ] | P0 | Joint | Publish the refund policy. | Policy states who can refund, permitted reasons, timing and Stripe processing expectations. |
| MVP-060 | [ ] | P0 | Joint | Publish the table-order cancellation policy. | Customer and staff responsibilities before/after preparation are clear. |
| MVP-061 | [ ] | P1 | Joint | Publish the reservation cancellation/no-show policy. | Public booking and confirmation email show approved wording. |
| MVP-062 | [ ] | P0 | Joint | Approve and publish the allergen disclaimer. | Menu tells customers to inform staff and does not replace product-level allergen information. |

## H. The Yew Trees staff handover and training

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-063 | [ ] | P0 | Yew Trees | Name the owner/manager account holder. | Named person accepts responsibility and completes login/password change. |
| MVP-064 | [ ] | P0 | Yew Trees | Name the kitchen account holder. | Named person accepts responsibility and completes kitchen login. |
| MVP-065 | [ ] | P0 | Joint | Complete secure credential handover. | Credentials are shared outside public chat, acknowledged, changed and stored securely. |
| MVP-066 | [ ] | P0 | Scanaki | Train staff on daily Scanaki operation. | Staff can manage KDS statuses, Stock, pause/resume, connectivity and plaque assignment without assistance. |
| MVP-067 | [ ] | P0 | Yew Trees | Nominate the live-incident contact. | Scanaki has one primary and one backup contact with phone/email and escalation hours. |

## I. Stripe live-payment launch

Do not start this section until sandbox acceptance is complete.

| ID | Done | Priority | Owner | Task | Completion condition |
|---|---|---|---|---|---|
| MVP-068 | [ ] | P1 | Yew Trees | Complete Stripe business verification. | Stripe account shows all required verification completed. |
| MVP-069 | [ ] | P1 | Yew Trees | Configure the payout bank account. | Bank is verified and a payout schedule is approved. |
| MVP-070 | [ ] | P1 | Yew Trees | Configure Stripe business profile and approved statement descriptor `YEW TREES PUB`. | Customer bank statement wording is recognisable and support contact is correct. |
| MVP-071 | [ ] | P1 | Joint | Replace sandbox restaurant keys with live restricted/publishable keys. | Keys are encrypted/configured without exposing unrestricted secrets; live account identity is verified. |
| MVP-072 | [ ] | P1 | Joint | Create and configure a separate live webhook. | Live signing secret is encrypted and all required payment/refund events return 2xx. |
| MVP-073 | [ ] | P1 | Joint | Run one real low-value table payment. | Real payment reaches the correct KDS card once and matches Stripe and Scanaki totals. |
| MVP-074 | [ ] | P1 | Joint | Refund the real low-value payment. | Stripe, Scanaki order state, reporting and customer outcome agree. |
| MVP-075 | [ ] | P1 | Joint | Verify payout and reconciliation. | Payment/refund appears correctly in reconciliation and Stripe payout reporting. |

---

## J. Final supervised pilot acceptance

| ID | Done | Priority | Owner | Acceptance test | Pass condition |
|---|---|---|---|---|---|
| MVP-076 | [ ] | P0 | Joint | Scan the Table 1 QR code. | Correct restaurant, location and Table 1 menu open. |
| MVP-077 | [ ] | P0 | Joint | Tap the Table 1 NFC tag. | Same permanent plaque URL and table context open. |
| MVP-078 | [ ] | P0 | Joint | Verify customer ordering context. | Location and room/table remain visible through menu, basket, payment and receipt. |
| MVP-079 | [ ] | P0 | Joint | Build a basket and complete sandbox payment. | Correct products, modifiers, total and payment result are shown. |
| MVP-080 | [x] | P0 | Joint | Verify kitchen release. | Exactly one correctly routed FIFO card appears after payment only. |
| MVP-081 | [x] | P0 | Yew Trees | Process the kitchen status lifecycle. | The Kitchen account moved full paid tickets through Pending, Preparing, Ready and completed delivery correctly in production. |
| MVP-082 | [ ] | P0 | Yew Trees | Test sold-out and restore. | Product becomes unavailable/available immediately and existing paid order remains intact. |
| MVP-083 | [x] | P0 | Scanaki | Submit a failed sandbox payment. | It never enters KDS and the customer can retry safely. |
| MVP-084 | [ ] | P0 | Joint | Disconnect venue Wi-Fi during service. | Tablet switches to SIM and KDS recovers without missing/duplicating orders. |
| MVP-085 | [x] | P0 | Joint | Close and reopen KDS. | New checkout is blocked while KDS heartbeat is stale and recovers when KDS returns. |
| MVP-086 | [ ] | P0 | Joint | Reassign a prototype plaque. | Permanent plaque link resolves to the new table and old basket/session is rejected. |
| MVP-087 | [ ] | P0 | Joint | Verify reporting. | Order, payment, location, table, products, timing and refund appear in the correct reports. |
| MVP-088 | [x] | P0 | Scanaki | Complete final encrypted backup/restore acceptance. | Backup and isolated restore pass after all pilot configuration is present. |

## K. Explicitly deferred beyond the Yew Trees MVP

| ID | Status | Owner | Deferred capability | Revisit when |
|---|---|---|---|---|
| MVP-089 | Deferred | Scanaki | Native Android application wrapper. | Browser/PWA pilot proves stable and packaging adds clear operational value. |
| MVP-090 | Deferred | Scanaki | Customer delivery ordering. | Dine-in pilot succeeds and delivery operations are staffed. |
| MVP-091 | Deferred | Joint | Separate Stripe accounts per location. | Legal/payment ownership requires split settlement and reconciliation. |
| MVP-092 | Deferred | Yew Trees | Second kitchen routing. | A second preparation area is physically operational. |
| MVP-093 | Deferred | Scanaki | Public self-service restaurant subscriptions. | Pilot pricing, billing and support processes are approved. |
| MVP-094 | Deferred | Scanaki | Advanced ingredient-level inventory integration. | Basic Stock controls are proven and supplier/inventory requirements are known. |
| MVP-095 | Deferred | Scanaki | Multi-restaurant chains. | Multiple paying venues require group-level administration. |
| MVP-096 | Deferred | Scanaki | Loyalty and courier expansion. | Core dine-in ordering, payment and KDS are stable in production. |

---

## Current verified baseline

- `scanaki.uk`, TLS, Docker services, automated health monitoring and reconciliation are operational.
- Encrypted VPS backups are running.
- The Yew Trees has four locations, 38 enabled ordering points and the unlimited internal Pilot tier: 17 pub points, 8 Sports Lounge tables and 13 Premium Building rooms. Main Building remains inactive.
- Delivery is disabled for the pilot.
- Stripe sandbox tenant keys and signed webhook are configured.
- The Yew Trees currently has twenty available products, but no linked product images and no allergen-reviewed products.
- The Yew Trees customer menus use the approved [gold tree logo](brand-assets/yew-trees-logo.jpg) with the deep green-black brand colour `#0B1A11`; the edge-to-edge [live hero treatment](evidence/2026-08-27-yew-branding/yew-logo-integrated-final.jpg) removes the generic white upload frame.
- Premium Building currently uses temporary labels `PB1`–`PB13`; final hotel room numbers remain changeable without replacing QR/NFC plaques.
- All 38 Yew Trees ordering points have unique permanent Smart Plaque assignments. The live-validated [URL register and print assets](print-assets/yew-trees-plaques/yew-trees-smart-plaque-urls.md) cover 17 pub points, 8 Sports Lounge tables and 13 Premium Building rooms; NFC tags are not yet written or verified.
- The production KDS device records are stale/offline, so unattended customer checkout is safely gated.
- The smart-plaque request/fulfilment workflow and scoped platform/courier/customer password-recovery UI are deployed to production.

## Completed evidence — 26 August 2026

- Production release `2f3e7b5f7` is healthy; schema migration `20260826230000` is applied.
- Pre-deploy encrypted backup completed and isolated restore passed with 76 schema tables.
- Full local regression: 526 backend tests passed; Angular production build passed.
- Live sandbox acceptance was repeated on 26 August 2026 using orders 6–8: a successful Visa test payment released one kitchen order exactly once; a duplicate signed webhook released none; failed and cancelled payments never reached KDS; the Stripe refund and signed refund webhook completed; an invalid signature returned HTTP 400; and payment reconciliation passed. The test orders were then cancelled and soft-deleted from the operational queue without removing their payment audit records.
- Live multi-location browser acceptance was completed using Indoor Table 1, Outdoor Bench 1, Sports Lounge Table 1 and Premium Building PB1. Every QR/NFC menu showed the correct location/ordering-point context and the same 20-item inherited menu; paid food orders appeared in FIFO order on the shared Kitchen display, while Coffee and Water correctly routed to the Bar display. A real mobile PB1 Stripe test-card checkout reached the visible `Payment successful!` state and `/confirm-payment` returned HTTP 200 after fixing its SlowAPI response injection. All screenshot orders were refunded and soft-deleted, the temporary kitchen login was restored and revoked, and reconciliation remained green.
- The Yew Trees was then switched to the configurable `kitchen_all` routing mode. Live paid order 17 proved that Coffee and Cheese Samosa appeared together on one Kitchen FIFO ticket. The redesigned ticket kept `PAID`, location, ordering point, items and the primary `Start`/`Ready` action visible; secondary customer, timing, item-state and note details opened through `Show more`; all controls remained contained at the 1280×720 tablet viewport. `Start` advanced both lines to Preparing and exposed `Ready`. The sandbox payment was refunded, the test order was soft-deleted, and the original Kitchen password was restored.
- Full production KDS acceptance was repeated with paid sandbox orders 18–20 from Indoor Table 1, Sports Lounge Table 1 and Premium Building PB1. Each ticket contained a beverage and food item, all six lines stayed together in the Kitchen queue under `kitchen_all`, and FIFO order, `PAID`, location and ordering-point context were correct. Location filtering, expanded details and the full `Start` → `Ready` → `Complete` lifecycle passed. Stock temporarily removed Water from the public menu while the already-paid PB1 ticket retained it, then restored Water successfully. The three Stripe payments were refunded, orders were cancelled and soft-deleted, the Kitchen password was restored, the KDS queue returned empty, payment reconciliation passed and production logs remained error-free. Full regression remained green at 526 backend tests plus the Angular production build.
- KDS typography was standardised on the Inter/system stack with font synthesis disabled. Synthetic 750–900 weights were removed, operational copy now uses real 500–700 weights, destination names top out at 26px/700, food lines use 18px/600 and ticket actions use 16px/600. The elapsed `Waiting` timer is permanently visible beside every table or room and uses tabular numerals. Angular production and spec TypeScript builds passed, and the final 1280×720 render is recorded in [the typography acceptance screenshot](evidence/2026-08-26-kds-typography/kds-typography-after.jpg).

### Full KDS acceptance screenshots

- [All-location paid FIFO queue](evidence/2026-08-26-kds-full/kds-full-01-fifo-all-locations.jpg)
- [Ready action and expanded details](evidence/2026-08-26-kds-full/kds-full-02-ready-show-more.jpg)
- [Combined Kitchen routing settings](evidence/2026-08-26-kds-full/kds-full-03-routing-settings.jpg)
- [Kitchen Stock control](evidence/2026-08-26-kds-full/kds-full-04-stock-control.jpg)
- [Sports Lounge location filter](evidence/2026-08-26-kds-full/kds-full-05-location-filter.jpg)
- [Empty queue after completion](evidence/2026-08-26-kds-full/kds-full-06-no-active-orders.jpg)
- Live KDS gate returned `KDS_OFFLINE` after the heartbeat expired and reopened for the controlled payment test when heartbeat was current.
- Legacy platform administrator was disabled and existing tokens were revoked.
- Live customer, courier and platform forgot-password pages render on mobile without browser errors. Email delivery remains blocked until `MVP-004` is supplied.
- Scanaki platform identity, support/contact email, public phone/address, sender identity and approved Terms/Privacy URLs are saved in production.
- The Yew Trees production layout now contains 17 pub points, 8 Sports Lounge tables, 13 Premium rooms and no active Main Building points (38 total); Premium menu overrides are enabled for location-specific prices.

## Related references

- [The Yew Trees pilot runbook](0078-yue-tree-pilot-runbook.md)
- [Multi-location operations guide](0087-multi-location-operations-guide.md)
- [Smart plaque request and fulfilment](0088-smart-plaque-request-fulfilment.md)
- [Restaurant owner manual](Scanaki-Multi-Location-Restaurant-Owner-Manual.docx)
