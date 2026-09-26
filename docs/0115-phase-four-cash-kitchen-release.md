# Phase 4 cash-prepayment kitchen release

Date:2026-09-09. The application correction is deployed and verified within the
checks below. **Phase4 remains open; this is not final go-live approval.**

## Root cause and correction

The rehearsal's paid cash order had `requires_prepayment=true` and `paid_at` set,
but no `kitchen_released_at`. The protected kitchen feed correctly omitted that
order. This was a manual-settlement path defect, not a reason to weaken the feed.

The shared payment service now sets the release timestamp when the entire balance
is covered. The zero-balance mark-paid branch does the same. Partial payments do
not release early, existing timestamps are preserved, and unpaid, cancelled and
fully refunded orders are excluded. The change is committed with settlement,
before the existing update publication. No schema migration was needed.

## Release and evidence

- Implementation commit: `7794423ea`.
- Protected PR: https://github.com/mmarzook3/OneTable/pull/16
- Deployed SHA: `d23e7e68e48cf1ae51064b117804d5a3f690f204`, version2.2.3.
- Successful deployment: https://github.com/mmarzook3/OneTable/actions/runs/34298482748
- Local isolated backend suite: **37 tests,26 subtests passed**.
- Same suite against the deployed immutable VPS image: **37 tests,26 subtests passed**.
- Regression coverage includes real HTTP cash settlement/feed visibility, final partial payment, zero-balance settlement and release safety boundaries.
- Required release checks, production Angular compilation, public health/readiness, landing/mobile navigation and API-docs smokes passed.
- Post-deployment backend/frontend related-error scans were zero; health and payment reconciliation passed. Disk usage75%.
- Health identified encrypted backup `scanaki_20260909_011746.sql.gz.enc`; no cloud-copy claim is made for that newer backup here.

The backend suite runs against an isolated database on the VPS, not the live
customer database. Public smoke checks separately confirmed the exact deployed
SHA. This does not substitute for the remaining full live browser rehearsal.

## Local transaction rehearsal

The helper invocation now supplies `PYTHONPATH=/app` for seeding and cleanup.
The complete local functional run passed at2026-09-09T01:09:24.984Z:

- Actual public order creation and idempotent duplicate submission.
- One cash700-cent payment and exact balance reconciliation.
- Kitchen/bar ticket visibility with the correct product in each display.
- Preparing, ready, delivered and completed transitions.
- Actual two-item receipt700-cent total and in-memory PDF, with physical printing suppressed.
- Sales report: one order and700-cent revenue.
- Tenant14428/order5456 and the checked fixture pulse keys were removed; protected records were unchanged.

The receipt harness needed its staff page brought to the foreground after opening
the two display pages. Earlier receipt timeouts/interrupted runs were not counted
as passes. Known Google Fonts stylesheet attempts on guarded pages were blocked;
unknown external requests still fail the test.

## Rehearsal-tool review still open

The transaction fixture, browser test and coordinator remain uncommitted drafts.
Their functional assertions passed locally, but review found three safeguards
that must be corrected before running that harness against the VPS:

1. Establish recoverable fixture identity before committing seed data, and include
   seeding/parsing in the cleanup lifecycle.
2. Redact token-bearing paths in blocked-request diagnostics before journaling.
3. Apply request guards to receipt popups as well as the main test pages.

These findings are not being counted as passing security checks. No full VPS
transaction-browser run is claimed. Approval for these corrections was requested
in the conversation. Physical acceptance remains deferred as agreed.

## Current release image identities

Captured under the deployment lock after verifying the exact release marker:

```text
back sha256:9f601b9abd8157f39826a462fd624bec38b133b8ef9f3dbb7550bb2ca6ad980d
front sha256:fd5a647375165c29550f298fe632d318c69c0b129f0aed9480de9c6d0526bd8f
postgres sha256:697c180dbf244d3ce4a8f4cbc0156cde840af055c1bf8b76aebe422a4822086f
```

Full application recovery/rollback evidence must reference this newer release,
not silently reuse the older bounded database-recovery checkpoint as proof.
