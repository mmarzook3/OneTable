# Phase 4 isolated database logging fix

The plaintext-in-Docker-logs finding from record0113 is resolved for the isolated
database recovery tool. Production application and database logging are unchanged.

## Change and verification

`scripts/scanaki-isolated-restore-check.sh` now passes `--log-driver none` to both
the temporary PostgreSQL container and backend model-readback container. This
prevents PostgreSQL server error statements/COPY values from being retained by
Docker's logging driver; suppressing only client output was insufficient.

- The corrected tool was uploaded to the VPS and the approved encrypted backup was restored successfully:79 schema tables,77 model tables readable,0 orphan ordering points.
- Owned temporary containers were removed and production health/payment reconciliation passed afterward; disk81%.
- A separate disposable PostgreSQL test confirmed its actual configured log driver was `none`. A deliberate synthetic SQL error could not be read from Docker logs. Its container was removed.
- Bounded independent review accepted the logging correction and the previously verified cleanup/identity guards.
- No live database restore, production logging change, real payment or customer email occurred.

The tool requires an exact release SHA and the independently approved backend
image digest, takes the deployment lock while capturing identities, and refuses
ambiguous cleanup. Use its documented four-argument `--execute` interface with
the passphrase supplied privately through the approved operations environment.

This remains a database restore/model-column readback check, not proof of full
application startup, uploads, complete recovery or rollback. Those Phase4 gates
remain open.

## Kitchen rehearsal status

The transaction draft has scoped device-write guards and a coordinator with
credential-free cleanup checkpoints. Its next local invocation stopped before
fixture creation because the helper uploaded under `/tmp` could not import
`app`; the coordinator needs the backend import path supplied when invoking it.
That run left no new fixture behind. Kitchen-ticket verification has not passed,
and no successful VPS end-to-end transaction rehearsal is claimed.

The restore tool is committed as verified tooling. The transaction fixture,
browser script and coordinator remain unfinished drafts pending the import-path
correction and full local/VPS checks. Phase4 and final physical acceptance remain
open.
