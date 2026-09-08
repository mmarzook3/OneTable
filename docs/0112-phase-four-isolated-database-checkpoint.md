# Phase 4 isolated database recovery checkpoint

Recorded2026-09-08T23:44:22Z. Phase 4 remains open; this is not go-live approval.

## Executed check

The encrypted database backup `scanaki_20260908_224903.sql.gz.enc` and checksum
were copied from the approved Drive mount to VPS `tmp/phase4-offsite`. Cloud
presence was previously confirmed through the connector (see record0111).
This was a Drive-mounted-copy restore, not a fresh API-stream download.

A draft isolated runner restored the checksum-verified backup into a separately
named PostgreSQL container with network disabled and tmpfs storage. A second
container using the current deployed backend image queried the current model
columns against that database. No live database endpoint or production volume
was supplied to either container, and no application lifespan was entered.

- Deployed release checked: `4cef94ab6f05647a6926fa7dc44cca2ef51a3f29`.
- Restored public schema tables: **79**.
- Current model tables read: **77**.
- Orphan ordering points: **0**.
- Out-of-scope path and wrong-release arguments were rejected.
- A separate Docker check confirmed no rehearsal-labelled containers remained.
- Production health/payment reconciliation passed afterward; disk81%.
- No real payment, provider call, customer email, live restore or cutover occurred.

This proves this run's database restore and bounded model-column readback only.
It does not prove full startup, uploads, application behavior or rollback.

## Runner review findings

The working draft `scripts/scanaki-isolated-restore-check.sh` is **not approved as
finished tooling**. Review identified two corrections needed before reuse:

1. Do not treat a failed Docker inspection as successful absence during cleanup.
2. Capture the release marker and image identities under the existing deployment
   lock so a concurrent deployment cannot invalidate the release association.

The separate cleanup check passed for the executed run. These remaining general
runner defects are not being concealed by that positive result. The draft was
uploaded solely as test tooling, not integrated into scheduled operations.

## Transaction rehearsal draft

The new local synthetic transaction harness passed order creation and duplicate
idempotency but stopped at cash settlement with HTTP400. Its request incorrectly
sent `tip_amount_cents` for a fixture using percentage-tip mode; the harness must
use the matching `tip_percent` contract. This was a test-harness issue, not proof
of a production payment regression. One external browser request was blocked;
sanitized destination diagnostics are still needed before interpreting it.

Local fixture and Redis cleanup passed, with protected retained fixtures
unchanged. No VPS transaction run occurred. The draft files are
`scripts/phase4-transaction-fixture.py` and
`front/scripts/test-phase4-transaction.mjs`; they are not accepted tooling yet.

Next work is to correct the three runner issues, rerun the checks, then complete
current-release application/rollback and full transaction/report reconciliation.
The four physical checks remain deferred until after Phase4 engineering.
