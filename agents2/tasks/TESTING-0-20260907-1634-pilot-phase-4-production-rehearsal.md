# Pilot phase 4: production rehearsal and go/no-go

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 4 production rehearsal and go/no-go
- **URL:** None
- **Labels:** pilot-readiness, phase-4

## Meta

- **Status:** `engineering-complete-final-acceptance-deferred`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** Phases 0-2 verified; Phase 3 verified or explicitly excluded; human deployment approval
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## Dependency Gate

Do not promote, deploy, mutate production, or rename this task until every prerequisite is satisfied and human approval is recorded in this file.

## 1. Objective

Perform a controlled production rehearsal and issue a defensible pilot launch decision.

## 2. Acceptance Criteria

User-approved sequencing, 2026-09-08: finish Phase 4 engineering before the combined hands-on session (Your Inputs P2-07 through P2-10). Phase 2's engineering-complete checkpoint can satisfy its engineering prerequisite, but cannot satisfy final physical acceptance. Do not issue GO or call Phase 4 fully accepted before the session passes.

- [x] Human approval and the selected engineering release are recorded: `d23e7e68e48cf1ae51064b117804d5a3f690f204`.
- [x] `development` was promoted through protected PR16 with required checks.
- [x] Production deployment succeeds and readiness returns HTTP200.
- [x] Safe production browser smokes and the guarded synthetic transaction pass.
- [ ] Customer live onboarding and controlled real payment/refund acceptance remain before live card service; the recorded maximum is not a passing result.
- [x] Electronic kitchen/bar, receipt/PDF, reconciliation and sales reports agree.
- [ ] Physical printing/NFC/camera/Wi-Fi acceptance remains deferred to the agreed final session.
- [x] Backup age, bounded recovery checks, prior alert delivery, TLS and disk evidence are recorded and healthy within the stated scope.
- [x] Disabled modules and known limitations are recorded.
- [x] Guarded rollback command, tested baseline and operator/approval roles are documented.
- [x] The report declares engineering PASS and final-launch NO-GO pending operator acceptance.

## 3. Human Approval Record

- **Approved by:** Project user: "Let's start Phase 4", following the Phase 3 release acceptance.
- **Rehearsal release SHA:** `d23e7e68e48cf1ae51064b117804d5a3f690f204`, the user-authorized Phase4 cash/KDS correction (protected PR16, workflow34298482748).
- **Approved production mutations:** Existing authorization for strictly scoped synthetic fixtures and cleanup; no new real-money payment/refund, customer email, live database restore or live cutover is authorized by starting this rehearsal.
- **Approval date:** 2026-09-09, Europe/London.

Phase 3 acceptance is recorded in `docs/0110-phase-three-pilot-acceptance.md`.
The four physical checks remain deferred until Phase 4 engineering is finished.
Scanaki SaaS billing remains operator-managed bank transfer with platform Stripe
deferred until after the pilot; customer Stripe is restaurant-payments-only.
No application change or redundant redeployment is required merely to begin
rehearsing this exact, successfully deployed release.

## 4. Testing Instructions

Run read-only production health and browser checks first. Stop immediately on failure. Real payment/refund and persistent data creation remain separate, explicit actions. Attach safe command summaries and links to deployment evidence without secrets or customer data.

## Status Tracker

Engineering acceptance: `docs/0117-phase-four-engineering-acceptance.md`.
All four tooling findings are resolved and the required engineering checks passed.
No further pilot engineering is queued absent a new failure or requirement.
Only explicit operator/physical/onboarding acceptance remains; do not fabricate
those results or declare customer GO. Continue recurring backup protection.

| Phase | Status | Notes |
|---|---|---|
| Created | Complete | |
| Prerequisites | Passed for engineering | Phase 3 accepted; user explicitly started Phase 4; physical split gate remains |
| Deployment | Verified | Version2.2.3, exact d23e7e68e SHA; protected PR16 deployment succeeded |
| Engineering testing | Passed | Full VPS transaction, isolated recovery, privacy and rollback safeguards/replacement verified |
| Operator testing | Deferred as agreed | Physical session and customer onboarding before final acceptance |
| Go/no-go | NO-GO for customer launch | Engineering complete; final operator evidence required |

