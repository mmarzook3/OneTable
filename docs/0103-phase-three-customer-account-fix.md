# Phase 3 customer-account correction

Date: 2026-09-08. Phase 3 remains in progress.

## Findings and changes

The expanded isolated suite initially produced 35 passes and two failures.
Customer email verification raised a SlowAPI exception after returning its
dictionary because no FastAPI Response parameter was available for rate-limit
headers. Verification, resend-verification and both password-reset dictionary
routes now accept the injected Response. Authentication, limits, token lifetime,
single-use behavior and response bodies were not weakened or changed.

The subscription historical-price test failed before its billing call because
it assumed migration-seeded pricing existed. Its fixture now creates the expected
active Pro row when absent in an empty metadata-created database. Existing
assertions about replacing historical Stripe items remain intact. No billing
implementation change was needed for that failure.

`scripts/test-phase3-backend.ps1` now provides repeatable local/VPS core and
extended runs. Each uses a disposable PostgreSQL container, tmpfs database,
network isolation and synthetic settings. TCP readiness avoids PostgreSQL's
temporary socket-only initialization server. Remote input strips Windows
carriage returns. The VPS target deliberately selects the deployed backend image;
it cannot validate pending application changes before deployment.

## Verification

- Expanded suite after the fix, including customer password resets: **39 passed locally**, **39 passed on VPS after deployment**.
- Core offline/group suite through the reusable runner: **9 passed locally and on VPS**; the revised remote wrapper exited successfully.
- Independent review found no material Python-diff issue; the reported runner readiness race was corrected.
- Live public verification with a throwaway customer: HTTP 200, persisted verified state, consumed-token replay HTTP 400. The fixture was deleted; no verification email was sent.
- Public browser entrypoints passed at 390px and 1280px: customer login, registration and booking forms; no form submission.
- Production deployment checks and Angular production build passed. Post-deploy health/payment reconciliation and affected-service error-marker checks passed.
- Dependency deprecation warnings remain; no dependencies were installed to suppress them.

## Release

- Application fix: `9d9bc493c`.
- Runner readiness correction: `320315546`.
- Protected PR: https://github.com/mmarzook3/OneTable/pull/7
- Deployed SHA: `8bf1720c025c075b35dd429e4f1b570a2a56bdd7`.
- Successful workflow: https://github.com/mmarzook3/OneTable/actions/runs/34229722906

These are selected backend and live account-route checks, not complete acceptance
of all eight optional modules. Interactive reservation/delivery/loyalty/offline/
subscription/group workflows and any provider-specific prerequisites remain to
be reconciled. The approved physical checks remain deferred to the final session
after Phase 4 engineering. No customer go-live is declared.
