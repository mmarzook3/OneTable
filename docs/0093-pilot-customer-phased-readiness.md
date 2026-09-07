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

- Codex heartbeat automation: `scanaki-pilot-phased-readiness` (hourly)
- Human input and evidence tracker: [Scanaki Pilot Readiness](https://docs.google.com/spreadsheets/d/1Cq9GTEMMPhpEMv0dL_g-Atx3tT-OU2aIxdciXuoDJm4/edit)
- Google Drive folder: [Scanaki](https://drive.google.com/drive/folders/1YzVpTQCXrs83SgnNfF1cg0vwZ4FT3HTw)

The heartbeat reads the tracker before every phase and human-gated action. On a failed test, failed deployment, unhealthy live check, missing required answer, or missing approval, it records the evidence, pauses itself, and reports the exact user action required in the current Codex thread.

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

Later phases must remain `FEAT` and must not be renamed or implemented until their predecessor is present as a verified `CLOSED` task under `agents2/tasks/done/`. A blocked phase records the missing prerequisite and exits without editing application code.

## Phase sequence

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
