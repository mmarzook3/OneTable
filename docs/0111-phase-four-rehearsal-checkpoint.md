# Phase 4 rehearsal checkpoint

Started 2026-09-09 Europe/London (verification timestamps below are UTC).
Status: **engineering rehearsal in progress; NO-GO for customer launch**.
This is an initial checkpoint, not Phase 4 acceptance.

## Release and initial checks

- Rehearsal SHA: `4cef94ab6f05647a6926fa7dc44cca2ef51a3f29`, version2.2.2.
- Protected PR15 and deployment workflow34287597616 were confirmed successful.
- Fresh public production smoke passed: health/readiness, landing and mobile navigation, footer routing, exact release identity and API documentation.
- Operations health and payment reconciliation passed; disk usage81%.
- Public TLS hostname/certificate validation passed; certificate expires2026-11-21T23:15:27Z.
- No application code or live configuration was changed to start this rehearsal.

## Offsite backup checkpoint

At2026-09-08T23:02:07Z the existing copy script transferred the latest encrypted
database and the latest complete recovery bundle with local SHA256 verification.
The first Drive search did not yet show the new database; a subsequent folder
listing confirmed both database and checksum in the cloud. Local mount presence
was not used as proof of cloud delivery.

- Database: `scanaki_20260908_224903.sql.gz.enc`, cloud ID `1oM2OD7aJfO1aCd8ScomfngSMyj9VCGGw`, 71328 bytes.
- Database checksum: cloud ID `1FwHY2T7sTlla7xJ5y0ll-SBQiiJL3sDa`.
- Complete bundle: `scanaki_recovery_20260908_120656_ef198eb06bf2`, cloud folder `1Olr1X-REED_uFXRw1Dq5lYpCeCDR6H5u`.
- Bundle file: `1N0-KRMapi7r-TsuojA9WRjGEeWtAJxOT`; checksum file: `1LMkD2rYut4JrV2739o3EC6he1NnrMRN1`.

The database and complete bundle have different creation times. Both were within
24 hours; do not describe them as one newly generated, internally synchronized
recovery snapshot. The local transfer JSON still leaves `cloudVerified=false`;
this connector evidence and the tracker separately record cloud confirmation.
Recurring backup work continues.

## Read-only operations probe

Functional assertions passed for retained synthetic order147 (due500, paid500,
remaining0), tenant-scoped kitchen feed, kitchen/bar display controls, report
date presets and the GBP5 receipt popup/in-memory PDF. Physical printing was
suppressed. No fixture, order, payment, provider or email writes were executed.

The strict zero-write-attempt assertion **did not pass**. A diagnostic repeat
identified exactly two blocked `POST /api/tenant/kitchen-devices/pulse` requests,
which are device-presence heartbeats. They were not allowed through. Browser
exceptions were zero; retained fixtures were preserved. These assertions are
partial evidence, not a completed transaction or device-presence rehearsal.

Authentication used an authorized short-lived synthetic-owner session after a
historical fixture password check failed. Real password login was not verified.
No new order-to-kitchen transitions or report aggregate reconciliation were
proved by this read-only probe. Evidence is in
`tmp/phase4-readonly-operations-vps-diagnostic.json`.

## Recovery and rollback gap

Read-only inspection confirmed recent backup/restore log success and the
preserved frontend archive with its documented SHA256. Previous full rehearsals
cover older releases; no migration changes alone do not prove current-release
compatibility. The documented production DB-container restore-check was not run
as a substitute for an isolated rehearsal.

No reusable full-isolated runner survived in the bounded locations inspected.
The next engineering step is to reconstruct a maintainable runner with pinned
images, isolated storage/network, no public ports, no provider/mail access and
strict cleanup, then verify current application recovery and compatible rollback.

Pinned current VPS images:

```text
back sha256:edc72433f668849297c2691271aa5c34189b1bf6e600d9158fc330a8d199a6c6
front sha256:a04c63a1fa96a0b93ac7e32a644cc43251ddc43d22a249c89edd18ce5302d612
postgres sha256:697c180dbf244d3ce4a8f4cbc0156cde840af055c1bf8b76aebe422a4822086f
```

Preserved frontend archive:
`/opt/scanaki/app/backups/recovery/scanaki_frontend_7a3e0cbd_20260908.tar.gz`.
Verified SHA256: `4c11c7b2d50431178f105ae58d7590b23b28bacaabe809e686c9dba6356fb8c5`.
An executable rollback procedure, current compatible rollback release and named
responsible operator still require reconciliation before final acceptance.

## Remaining acceptance

- Disposable end-to-end order/kitchen/bar/receipt/report reconciliation, with deliberate device-presence handling and cleanup.
- Current-release isolated recovery and rollback proof, executable runbook and operational responsibility.
- Final release, alert, backup and limitation evidence reconciliation.
- The agreed combined physical session after Phase4 engineering: paper printing, spare NFC write/read-back, first camera permission/printed QR and venue Wi-Fi recovery.
- Any real low-value payment/refund requires separate specific authorization; no new real-money action was authorized or attempted here.

Pilot SaaS collection remains operator-managed bank transfer. Platform Stripe
is deferred, and the first customer's Stripe account is restaurant-payments-only.
