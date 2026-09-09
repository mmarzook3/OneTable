# Pilot phase 4: production rehearsal and go/no-go

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 4 production rehearsal and go/no-go
- **URL:** None
- **Labels:** pilot-readiness, phase-4

## Meta

- **Status:** `engineering-rehearsal-in-progress`
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

- [ ] Human approval identifies the exact release SHA.
- [ ] `development` is promoted through the documented controlled workflow.
- [ ] Production deployment succeeds and readiness returns HTTP 200.
- [ ] Safe production browser smokes pass.
- [ ] A real low-value payment and refund pass only when explicitly approved.
- [ ] Kitchen/bar, receipt, printing, reconciliation, and reports agree.
- [ ] Backup age, restore-check, alerts, TLS, and disk are healthy.
- [ ] Disabled modules and known limitations are recorded.
- [ ] Rollback command and responsible operator are confirmed.
- [ ] The test report declares `GO`, `CONDITIONAL GO`, or `NO-GO` with evidence.

## 3. Human Approval Record

- **Approved by:** Project user: "Let's start Phase 4", following the Phase 3 release acceptance.
- **Rehearsal release SHA:** `4cef94ab6f05647a6926fa7dc44cca2ef51a3f29`, the already approved/deployed Phase 3 release (protected PR15, workflow34287597616).
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

Latest checkpoint: `docs/0113-phase-four-runner-guard-checkpoint.md`.
Restore cleanup and release/image guards passed positive and negative checks;
isolated PostgreSQL logging must still be disabled to prevent decrypted SQL in
error logs. The transaction tip-field mismatch is corrected, but kitchen-stage
verification and a reliable cleanup coordinator remain open. The leftover local
fixture was safely removed. Neither draft is accepted tooling. Full application
recovery/rollback, transaction reconciliation and final physical acceptance remain.

| Phase | Status | Notes |
|---|---|---|
| Created | Complete | |
| Prerequisites | Passed for engineering | Phase 3 accepted; user explicitly started Phase 4; physical split gate remains |
| Deployment | Existing release verified | Public footer reports exact SHA and version2.2.2; protected PR15 deployment succeeded |
| Testing | In progress | Initial production health/readiness, landing/mobile navigation and API-docs smoke passed |
| Go/no-go | Pending | |

