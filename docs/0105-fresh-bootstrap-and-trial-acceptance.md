# Fresh bootstrap correction and clean-schema trial verification

Checkpoint: 2026-09-08. Phase 3 remains in progress.

## Root cause and correction

Application startup creates current SQLModel metadata before applying historical
migrations. The historical platform-settings singleton insert omitted newer
non-null fields whose defaults existed only in Python. PostgreSQL rejected the
insert. Startup then caught the migration exception and continued serving.

The historical migration now conditionally establishes SQL defaults for
`smtp_auth_required`, `remember_session_days` and `remember_inactivity_days`
when those later columns exist. Legacy schemas without those columns remain
supported by the guards. Existing singleton values are not rewritten.
The lifespan now propagates database-initialization exceptions instead of starting
workers and serving after failure. This also makes failures in the existing
legacy Stripe-secret migration within that initialization block fatal.

Regression tests cover the full metadata-first migration history, repeat
execution, preservation of custom singleton values, and an injected failure that
must prevent lifespan startup. The destructive bootstrap test refuses ordinary
pytest discovery before importing `app.db`: it requires the explicit isolated
runner marker, dedicated database name and loopback host. The runner creates a
disposable database container with tmpfs storage and no external networking.

## Release and tests

- Application/migration fix: `b116923c0`; test-isolation guard: `6732360bd`.
- Protected PR: https://github.com/mmarzook3/OneTable/pull/10.
- Deployed SHA: `204c78c641ef313aacd2a31d771089443dbf79ff`.
- Successful workflow: https://github.com/mmarzook3/OneTable/actions/runs/34240998632.
- Bootstrap regressions: **2 passed locally, 2 passed on the deployed VPS image**.
- Negative safety check: unmarked test loading skipped before `app.db` import.
- Public browser baseline, health/readiness, payment reconciliation and checked service-log error markers passed.
- Required CI and production Angular build passed. The test-isolation review finding was addressed and its GitHub thread resolved before normal protected merge; protection was not bypassed.

## Independent cold start and trial UI

The deployed backend image
`sha256:7557379488e29342fbcc0ac2ed2a1576064f25b35d1398fac5075ac822d8d84b`
started through its real ASGI lifespan on an empty isolated database. Health
returned 200, startup completed and migration version `20260907190000` matched
the latest image migration. Initialization, migration, startup, traceback and
error-marker counts were all zero. Elapsed time including cleanup was 15.354
seconds; this is not an outage-recovery SLA.

A second fully migrated isolated stack repeated the actual enabled-paywall UI:

- A new synthetic tenant was gated from dashboard/orders (HTTP 402).
- Selecting Pro and clicking start trial returned HTTP 200, enabled dashboard/orders access and persisted exactly one trial-start event.
- An expired synthetic trial remained gated. Retrying through the UI returned HTTP 400 `trial_already_used`, showed an error, preserved expiry and created no new trial event.

No provider keys, provider calls, checkout mocks, production billing toggles or
real customer data were used. Five containers, two volumes, one internal network
and temporary scratch were removed across the checks; SSH/browser sessions were
closed and no owned resources remained.

Evidence remains local in:

- `tmp/phase3-positive-fresh-asgi-204c78c-20260908.json`
- `tmp/phase3-clean-bootstrap-trial-ui-204c78c-20260908.json`

The earlier incomplete-migration caveat is resolved for these repeated tests.
The expired tenant was seeded past expiry rather than advancing a new trial's
clock. Provider checkout, subscription collection and webhooks are not proved by
this trial check. Delivery-card testing separately found multiple test webhook
destinations producing mismatched-tenant HTTP 400 responses; that routing work
remains open, with no new payment attempted during preflight. Final physical
acceptance remains deferred as approved; this checkpoint is not Phase 3 closure.
