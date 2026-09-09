# Phase 4 runner guard checkpoint

Phase4 remains open. This supersedes the two restore-runner findings in record0112,
but does not approve the draft runner for further use yet.

## Corrections verified

- Cleanup now distinguishes a successful empty container listing from a Docker API error, refuses unverified ownership, and checks removal success.
- Release/image capture now holds the production deployment lock and also requires the approved backend image digest. The digest check covers a release marker copied ahead of a deployment.
- The corrected runner restored the approved Drive-copy backup on the VPS:79 schema tables,77 current model tables read,0 orphan ordering points. Cleanup passed.
- Wrong image and contended deployment lock were rejected. A mocked Docker inspection failure returned failure, did not claim cleanup success and did not remove an unverified container.
- An interrupted first guard-test invocation was not counted as passed; the explicit subsequent runs supplied the recorded results.
- No rehearsal containers remained and live health/payment reconciliation passed afterward.

## New safety finding

PostgreSQL currently uses Docker's default logging driver in the isolated restore
container. On an unsuccessful restore, server error logs could retain decrypted
SQL or COPY values outside tmpfs. Redirecting the client output is insufficient.
Disable logging for that isolated container before further restore runs. This is
a potential exposure path, not evidence that a data exposure occurred in the
successful checks. No production logging change is proposed.

## Transaction harness

The approved tip-field correction is implemented, and local order creation,
duplicate idempotency and cash700 settlement now pass. The kitchen-ticket stage
still times out. Its strict guard blocked device heartbeat/diagnostic writes;
those routes have not been allowed through or claimed tested. Google Fonts CSS
requests were blocked and identified separately from payment-provider traffic.

One diagnostic run lost its in-memory cleanup state and its initial cleanup
command used a missing container script path. The exact remaining fixture was
subsequently identified by its unique nonce, synthetic owner/product signature,
table and order relationship. Tenant14421/order5449 and its exact Redis keys
were removed using the guarded helper. Protected-record comparison covered this
cleanup only; the original pre-run fingerprint was unavailable.

A reliable transaction-test coordinator and the kitchen-stage diagnosis remain
necessary. There has been no successful VPS transaction rehearsal in this scope.
No production application code, real payment or customer data was changed.

The restore runner and transaction files remain uncommitted drafts pending these
remaining findings; only this verified checkpoint is committed. Full application
recovery/rollback and the final physical session remain separate open gates.
