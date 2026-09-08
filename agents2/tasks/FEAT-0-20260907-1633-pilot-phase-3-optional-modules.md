# Pilot phase 3: optional customer modules

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 3 optional customer modules
- **URL:** None
- **Labels:** pilot-readiness, phase-3

## Meta

- **Status:** `blocked-by-phase-2-and-scope`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** Verified Phase 2 task archived and explicit customer module scope
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## Dependency Gate

Do not rename this task or edit application code until Phase 2 engineering and VPS verification are complete and the included pilot modules are explicitly recorded. The user-approved `engineering-complete-physical-acceptance-deferred` Phase 2 checkpoint is sufficient for engineering handoff; it is not final acceptance. The four deferred hardware checks remain mandatory after Phase 4 engineering and before customer go-live. Unselected modules must be documented as excluded, not enabled or tested through production mutations.

## 1. Objective

Configure and verify only the optional modules included in the signed pilot scope.

## 2. Module Checklist

- [ ] Reservations and waiting list: included, excluded, or deferred
- [ ] Delivery and courier: included, excluded, or deferred
- [ ] Offline cash/deferred card: included, excluded, or deferred
- [ ] Android Kitchen distribution: included, excluded, or deferred
- [ ] Loyalty and wallet passes: included, excluded, or deferred
- [ ] Customer accounts: included, excluded, or deferred
- [ ] VeriFactu/TSE: included, excluded, or deferred with legal/provider evidence
- [ ] SaaS subscription/paywall: included, excluded, or deferred
- [ ] Restaurant groups and warehouses: included, excluded, or deferred

## 3. Acceptance Criteria

- [ ] Every module has an explicit scope decision.
- [ ] Every included module has deterministic automated tests where safe.
- [ ] Required physical, provider, certificate, and legal checks are documented.
- [ ] Unsupported behavior is stated clearly in customer-facing pilot notes.
- [ ] Excluded modules remain disabled and do not block Phase 4.

## 4. Testing Instructions

Run only tests for explicitly included modules. Mutation tests default to local or disposable data. Production reservation, delivery, email, wallet, payment, or fiscal actions require explicit human opt-in.

## Status Tracker

| Phase | Status | Notes |
|---|---|---|
| Created | Complete | |
| Prerequisite | Blocked | Phase 2 and customer scope required |
| Implementation | Pending | |
| Testing | Pending | |

