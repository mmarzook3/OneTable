# Phase 2 engineering handoff

Date: 2026-09-08. Status: **engineering-complete-physical-acceptance-deferred**.
This checkpoint permits the next engineering phase under the user's approved
split gate. It is not final customer acceptance or a go-live declaration.

## Release and verification

- Implementation commits: `ee466341e` (recovery bundle), `4561b3e1c` (daily backup integration and offsite copy correction).
- Protected PR: https://github.com/mmarzook3/OneTable/pull/6
- Production: `b6cb71005218664eaf5dd10a79e87c758e39ef72`.
- Successful deployment: https://github.com/mmarzook3/OneTable/actions/runs/34223913813
- Required backend regressions and Angular production build passed in CI.
- Production public browser baseline passed: health/readiness, mobile navigation, landing version, route restoration and API documentation.
- Recent backend/frontend/WebSocket logs had no matched fatal, traceback or build-failure markers. Production health and payment reconciliation passed.
- Kitchen/bartender role boundaries passed locally and on VPS. Ticket appearance without reload, routing exclusion, notes/paid badge, preparing/ready/delivered transitions and persistence after reload passed for both displays. VPS Bar reran once after the server's login cooldown; rate limits were not weakened. Synthetic fulfillment state was restored; no payment requests were made.

## Backup and independent key custody

The existing VPS cron runs `scanaki-ops-run.sh backup` daily at 02:20 UTC.
That action now produces the encrypted database dump, creates an allowlisted
configuration/uploads/database recovery bundle, and verifies its decrypt/extract
integrity. Existing health checks run every five minutes and database restore
checks weekly. The updated backup action and latest restore were also run now.

`sync-scanaki-backup.ps1` transfers both encrypted artifacts to the approved Drive
mount. It checks timestamps and checksums, retries transfers, prevents overlapping
copies, stages before publishing and refuses conflicting existing copies. Its
argument-handling bug was fixed by using explicit source/target objects. First
transfer and idempotent repeat both passed.

The existing pilot heartbeat is active and instructed to run this copy at least
daily after backup, catch up when available, independently confirm cloud objects,
and report failures/staleness. Local transfer state is not cloud evidence.

Latest tested set:

- Database: `scanaki_20260908_120655.sql.gz.enc`; Drive ID `1HXIzePHfu3J9USdDRaIP8AkzbPd53s4S`.
- Recovery folder: `scanaki_recovery_20260908_120656_ef198eb06bf2`; Drive ID `1Olr1X-REED_uFXRw1Dq5lYpCeCDR6H5u`.
- Cloud bundle: `1N0-KRMapi7r-TsuojA9WRjGEeWtAJxOT`, 1,955,872 bytes; checksum file `1LMkD2rYut4JrV2739o3EC6he1NnrMRN1`.
- Direct connector listing confirmed the database, bundle and sidecars in Google Drive.
- Latest database restore passed: 7 tenants, 15 locations, 47 ordering points, 79 schema tables.

The user explicitly selected the project-local, Git-ignored `.env` for the
independent recovery key. That local key successfully decrypted the earlier
Drive-mounted recovery bundle in a network-disabled container. No key or raw
environment content is included in evidence or commits. This custody choice is
plaintext and depends on protecting and retaining the laptop.

## Recovery and rollback evidence

Synthetic container tests passed for bundle roundtrip, permissions, allowlist,
missing/mismatched checksums, missing configuration, symlinks, tampering, wrong
key, hostile archives and cleanup.

The isolated application rehearsal restored 79 database tables and verified all
11 uploads; all 68 ORM table reads and API/frontend HTTP checks passed. Only
loopback networking was available, with no production integrations or published
ports. Test containers, volumes and decrypted scratch were removed.

The previous compiled frontend was recovered from existing build cache without
a rebuild; all 187 assets matched hashes and returned HTTP 200 against the
offsite-derived recovered database and compatible backend. Details, hashes,
operator restart/rollback procedure and cleanup are in
[the rollback report](0100-phase-two-frontend-rollback.md).

Measured restore-to-smoke interval: 21.045 seconds. Selected database backup age:
35 minutes 31.147 seconds. These are bounded rehearsal measurements, not an
end-to-end outage RTO or contractual RPO guarantee. The recorded pilot targets
remain 24-hour RPO and 4-hour RTO. Operations escalation is the project owner
through the previously tested `alerts@scanaki.uk` group; on-site contacts remain
in the approved tracker rather than duplicated here.

## Deferred final physical session and operational limitations

- Physical receipt and kitchen-ticket paper output.
- Spare NFC-tag write/read-back (phone read already operator-confirmed).
- First camera permission and printed QR plaque scan; final native-device checks are not inferred from browser tests.
- Venue Wi-Fi interruption/recovery rehearsal.

These remain open in Your Inputs P2-07 through P2-10 until the combined session
after Phase 4 engineering. They are never counted as passed by this checkpoint.

Offsite copying depends on this laptop, Drive and Codex availability. Cloud
retention is non-destructive; monitor capacity rather than assume unlimited
storage. Disk was 81% at the final configured health check and requires ongoing
monitoring. TLS was valid through 2026-11-21. Recovery tests did not re-provision a
new VPS, reissue production TLS, exercise external providers or perform a live
traffic cutover. Previous frontend testing was HTTP/asset/API compatibility,
not interactive browser acceptance of the old release or recovery of its original
OCI image. Customer go-live still requires the final physical and Phase 4 gates.
