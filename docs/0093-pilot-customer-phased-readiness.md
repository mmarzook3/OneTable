# Pilot customer phased readiness plan

## Objective

Prepare Scanaki for a controlled dine-in pilot through small, independently tested phases. The agent queue may implement and verify safe development work automatically, but production deployment, real payments, refunds, branch protection, and customer-facing changes retain explicit human gates.

## Authoritative release line

- Development repository: `git@github.com:mmarzook3/OneTable.git`
- Development branch: `development`
- Production branch: `master`
- Production URL: `https://scanaki.uk`
- Production promotion is allowed only after the relevant phase gate passes and a human explicitly approves it.
- The legacy `satisfecho/pos` history must not be merged into the pilot line automatically.

## Automated execution

The active phase files live in `agents2/tasks/` and follow the normal pipeline:

- Codex heartbeat automation: `scanaki-pilot-phased-readiness` (every five minutes; daily offsite-copy work with catch-up)
- Human input and evidence tracker: [Scanaki Pilot Readiness](https://docs.google.com/spreadsheets/d/1Cq9GTEMMPhpEMv0dL_g-Atx3tT-OU2aIxdciXuoDJm4/edit)
- Google Drive folder: [Scanaki](https://drive.google.com/drive/folders/1YzVpTQCXrs83SgnNfF1cg0vwZ4FT3HTw)

The heartbeat reads the tracker before each phase. It diagnoses recoverable failures, fixes them and retests without repeated routine approval requests. Genuine external blockers are recorded with the exact required action. Deferred physical checks do not block engineering handoff, and operational backup work continues while awaiting final physical acceptance. Offsite copying requires the laptop, Drive mount and signed-in app to be available; this is not an always-on VPS-to-cloud service.

```text
FEAT -> WIP -> UNTESTED -> TESTING -> CLOSED -> done/YYYY/MM/DD
```

Run one cycle:

```bash
./agents2/pos-cursor-loop.sh
```

Run continuously in the background:

```bash
./scripts/start-pos-cursor-loop-background.sh --restart
```

Later phases normally require a verified predecessor. User-approved exception (2026-09-08): Phase 2 may hand off after all engineering checks and VPS verification pass, with the four physical checks below explicitly deferred. Record `engineering-complete-physical-acceptance-deferred`, not `Passed` or verified `CLOSED`, until physical acceptance succeeds. Other unmet engineering gates still block handoff.

## Combined physical acceptance after Phase 4 engineering

The user approved one final hands-on session after Phase 4 engineering is finished:

- Physical receipt and kitchen-ticket paper output.
- Write a spare NFC tag and scan it back to the correct table/menu.
- First camera permission and printed QR plaque scan.
- Venue Wi-Fi interruption/recovery and ticket reconciliation.

Track these in the existing Google Sheet, Your Inputs P2-07 through P2-10. Phone NFC read is already operator-confirmed; writing remains unverified. Phase 4 may be engineering-complete before this session, but final acceptance and customer go-live remain blocked until all four pass. A deferral is never a passing test result.

## Phase sequence

Checkpoint, 2026-09-08: Phase 3 passed for the approved pilot scope; see
`docs/0110-phase-three-pilot-acceptance.md`. Pilot SaaS collection is directly by
bank transfer with operator-managed access and existing paywall enforcement off.
Scanaki platform Stripe is deferred until after the pilot; the first customer's
Stripe account is only for restaurant payments. Phase 4 and the final physical
acceptance session remain open. This checkpoint is not customer go-live approval.

| Phase | Task | Outcome | Gate |
|---|---|---|---|
| 0 | Release and test foundation | One release line, persistent browser-test environment, safe pilot smoke suite, verified recovery prerequisites | Repeatable safe smoke passes and release/rollback path is documented |
| 1 | Core transaction journey | One order traced from customer entry through payment, kitchen, receipt/refund, and reports | Deterministic end-to-end test passes without skips |
| 2 | Operations and hardware | Printing, tablets, connectivity, backups, alerts, disk, and recovery checks | Operational checklist passes with on-site evidence where required |
| 3 | Optional modules | Only contracted modules are enabled and tested | Every enabled module passes; excluded modules are documented |
| 4 | Production rehearsal | Approved release is deployed and verified | Written go/no-go result and exact production SHA |

## Global rules

- Work only on `development` until a human approves production promotion.
- Sync with `scanaki/development` before every edit and before push.
- Keep implementation scopes disjoint when sub-agents work in parallel.
- Use containers for dependencies and tests.
- Use `npm ci --ignore-scripts`; never use `npm install`.
- Run backend tests in Docker.
- After frontend changes, inspect the frontend build log and run the affected Puppeteer smoke.
- Do not run rate-limit tests in the normal pilot suite.
- Do not run registration, email-sending, reservation mutation, real-payment, or refund tests against production without an explicit opt-in.
- Store test screenshots and temporary evidence under `tmp/` and do not commit credentials or customer data.
- Every phase must include testing instructions, a test report, a commit, and a pushed `development` checkpoint.
- A failed gate returns the task to `WIP`; it never promotes the next phase.

## Pilot scope defaults

The default pilot covers dine-in ordering, staff authentication, QR/table context, basket totals, payment, kitchen/bar routing, receipts, printing, refunds, reports, and short connectivity interruptions.

The following are conditional and do not block the core pilot unless included in the customer agreement: reservations, waiting list, delivery, courier, loyalty, wallet passes, customer accounts, offline ordering, Android Kitchen distribution, VeriFactu/TSE, SaaS paywall, restaurant groups, and warehouse management.

## Human gates

Human approval is required before:

- Changing GitHub branch protection or repository settings.
- Promoting `development` to `master`.
- Deploying to production.
- Sending real customer email.
- Creating or refunding a real payment.
- Creating persistent production test data.
- Enabling live fiscal middleware.
- Declaring the pilot ready for customer use.

## Final evidence package

Phase 4 must provide:

- Exact production commit SHA and successful deployment run.
- Safe smoke-test results.
- Controlled payment/refund evidence when approved.
- Kitchen/bar and printing evidence.
- Backup age, restore-check, monitoring, TLS, and disk results.
- Known limitations and disabled modules.
- Rollback command and responsible operator.
- Final `GO`, `CONDITIONAL GO`, or `NO-GO` decision.
