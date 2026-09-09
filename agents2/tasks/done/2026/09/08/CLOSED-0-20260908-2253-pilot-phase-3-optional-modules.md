# Pilot phase 3: optional customer modules

## Closing summary

Closed for the user-approved pilot scope on 2026-09-08 UTC. Protected PR15
deployed `4cef94ab6f05647a6926fa7dc44cca2ef51a3f29`; workflow 34287597616 passed.
The final local and VPS payment suites passed: 33 tests, 23 subtests and eight
browser cases per environment. Synthetic cleanup, public smoke, health and
affected-service log checks passed. See `docs/0110-phase-three-pilot-acceptance.md`.
Implementation progressed through WIP, UNTESTED and TESTING before this closure.

The user explicitly deferred Scanaki platform Stripe until after the pilot;
pilot subscription collection is operator-managed bank transfer with the existing
paywall disabled. Customer Stripe is restaurant-payments-only. This is Phase 3
acceptance, not final go-live; Phase 4 and deferred physical tests remain open.

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 3 optional customer modules
- **URL:** None
- **Labels:** pilot-readiness, phase-3

## Meta

- **Status:** `closed-pilot-scope`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** Phase 2 engineering handoff in docs/0101-phase-two-engineering-acceptance.md and explicit customer module scope
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## Dependency Gate

Do not rename this task or edit application code until Phase 2 engineering and VPS verification are complete and the included pilot modules are explicitly recorded. The user-approved `engineering-complete-physical-acceptance-deferred` Phase 2 checkpoint is sufficient for engineering handoff; it is not final acceptance. The four deferred hardware checks remain mandatory after Phase 4 engineering and before customer go-live. Unselected modules must be documented as excluded, not enabled or tested through production mutations.

## 1. Objective

Configure and verify only the optional modules included in the signed pilot scope.

## Approved scope, 2026-09-08

The user explicitly confirmed "Use this scope": include reservations, delivery,
offline ordering, the Android app, loyalty, customer accounts, SaaS subscriptions
and restaurant groups. Defer warehouses. Exclude fiscal integrations. This
authorizes implementation and synthetic verification, not unrestricted live
payments, customer email, or production feature enablement before checks pass.
Existing final physical-acceptance deferrals remain in force.

## 2. Module Checklist

- [x] Reservations: included.
- [x] Delivery: included.
- [x] Offline ordering: included; never represent an offline card authorization as a completed payment.
- [x] Android app: included; final physical checks deferred as agreed.
- [x] Loyalty: included.
- [x] Customer accounts: included.
- [x] Fiscal integrations (VeriFactu/TSE): excluded by explicit user decision.
- [x] SaaS subscriptions: operator-managed pilot access and bank-transfer collection; platform Stripe deferred by user until after pilot.
- [x] Restaurant groups: included.
- [x] Warehouses: deferred.

These checked boxes record scope decisions, not passing module tests. Adjacent
services such as wallet-provider passes must not be activated merely because the
parent module is included; document provider-specific prerequisites when relevant.

## 3. Acceptance Criteria

- [x] Every module has an explicit scope decision.
- [x] Every included module has deterministic automated tests where safe.
- [x] Required physical, provider, certificate, and legal checks are documented.
- [x] Unsupported behavior is stated clearly in pilot operating notes in docs/0110-phase-three-pilot-acceptance.md.
- [x] Excluded modules remain disabled and do not block Phase 4.

## 4. Testing Instructions

Run only tests for explicitly included modules. Mutation tests default to local or disposable data. Production reservation, delivery, email, wallet, payment, or fiscal actions require explicit human opt-in.

## Status Tracker

| Phase | Status | Notes |
|---|---|---|
| Created | Complete | |
| Prerequisite | Passed for engineering | Phase 2 split gate passed; user explicitly approved scope |
| Implementation | Complete for approved pilot scope | Platform Stripe explicitly deferred; operator-managed billing |
| Testing | Passed | Local and deployed VPS evidence in docs/0110-phase-three-pilot-acceptance.md |
| Closure | Passed | Phase 4 and final physical acceptance remain separate |

