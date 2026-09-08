# Phase 3 backend baseline

Checkpoint: 2026-09-08. Phase 3 remains in progress under the approved module scope.

## Selected regression suites

- `back/tests/test_offline_cash_order.py`
- `back/tests/test_restaurant_groups.py`

Local result: **9 passed**, 8.22 seconds, one dependency deprecation warning.
VPS result: **9 passed**, 8.85 seconds, two dependency deprecation warnings.

Both runs used a new PostgreSQL 18 container with tmpfs database storage, no
published ports and network mode `none`. The test container shared only that
isolated namespace, used synthetic database/signing settings and created its own
schema. It did not connect to the live database or external payment/email
providers. The PostgreSQL container was removed after each run. The VPS run used
the immutable image selected from the running Scanaki backend, not a new build.

The VPS shell wrapper returned an error after pytest had completed because a
trailing Windows carriage return reached Bash. All nine pytest tests passed;
the cleanup trap ran and a separate check confirmed no disposable Phase 3
database containers remained. This transport error is not hidden as a successful
wrapper exit. Future multiline SSH input should strip carriage returns at the
remote pipe boundary.

Warnings concern Starlette/httpx TestClient and an anyio alias. No dependency was
installed or upgraded merely to suppress them. Test rate-limit overrides apply
only to these isolated test processes, not production configuration.

## Scope of this evidence

This is selected backend regression evidence for offline cash synchronization
and restaurant groups. It does not prove browser offline reconnection, card
processing without connectivity, every restaurant-group workflow, or full module
acceptance. Existing read-only customer login/registration/booking entrypoints
already passed on local and VPS targets at phone and desktop widths.

Still required: functional coverage and any fixes for reservations, delivery,
offline ordering, Android, loyalty, customer accounts, SaaS subscriptions and
restaurant groups, with affected live verification. Warehouses remain deferred;
fiscal integrations remain excluded. The four hands-on checks retain their
approved final-session deferral. No Phase 3 completion or customer go-live is
claimed by this checkpoint.
