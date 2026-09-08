# Pilot phase 2: operations and hardware

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 2 operations and hardware
- **URL:** None
- **Labels:** pilot-readiness, phase-2

## Meta

- **Status:** `blocked-on-physical-hardware`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** Verified Phase 1 task archived under `agents2/tasks/done/`
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## Dependency Gate

Do not rename this task or edit application code until Phase 1 is verified and archived. If it is missing, record the blocker and exit.

## 1. Objective

Checkpoint 2026-09-08: backup copied back from the approved Drive mount into a separate VPS temporary path and restored into an isolated database successfully (7 tenants,15 locations,47 points,79 tables). scripts/sync-scanaki-backup.ps1 copied the latest 20260908_022001 encrypted backup with checksum verification and refuses mismatched existing destination copies. Script committed and copied to VPS for reference; execution requires Windows laptop and Drive mount. A separate daily heartbeat was NOT created: the app permits only one heartbeat per task. Independent recurring backup scheduling remains pending explicit standalone-job authorization.

Physical capability check: tablet exposes camera/Bluetooth but no NFC feature. Bluetooth bonded-device list is empty. Physical printer and NFC test cannot be accepted with this device state. User action: pair/power the intended printer and provide an NFC-capable phone/tag for physical verification. Scheduler paused on this external hardware requirement, not on a software test failure. Ticket actions, full uploads/configuration recovery and remaining acceptance items still open.

Checkpoint 2026-09-08: tablet authenticated as the synthetic tenant23 kitchen user. Landscape KDS rendered; a brief Wi-Fi disable showed the native heartbeat-failure warning. Wi-Fi was restored in a finally block, the warning cleared, and VPS recorded a recent heartbeat. Force-stop/cold launch preserved the authenticated KDS session. No real customer account was used. Ticket actions and physical printer/NFC acceptance remain open.

Cloud backup visibility is now confirmed by direct folder listing (filename search missed binary files). Drive Backup folder id 1hpN--7WKssWq45mJ6ECe9Zli0UFkM64o contains encrypted file id 1xoDBUFmt9fxkat9xzqPqMcswDn4yOUH4 and checksum id 1qraqUX-Kkbv7uzm5FE1HzjrtxGyVxWMI. Authenticated raw fetch returned a 70576-byte file reference. The Drive-mounted copy checksum matched the VPS original; a separate checksum of the provider stream and full recovery from the cloud copy are not yet claimed. Recurring offsite replication is not yet implemented.

Checkpoint 2026-09-08: encrypted backup scanaki_20260907_231202.sql.gz.enc and checksum copied from VPS to G:\My Drive\Scanaki\Backup. Local destination SHA256 matches. Google Drive connector did not yet find the cloud object; cloud upload/retrieval is NOT verified. The authorized USB tablet is online but its lock screen is showing (ADB window state and screenshot). Scheduler paused for user unlock; do not bypass the lock screen. Leave the Kitchen app visible to resume device testing. Physical print and NFC acceptance remain unverified.

Initial inventory 2026-09-08: authorized ADB tablet ALDMJV6429H00568 is connected. Installed uk.scanaki.kitchen reports versionName 0.3.1/versionCode6. Bluetooth manager reports STATE_DISCONNECTED at inspection time; this is not proof that printing cannot connect on demand. Physical printer, QR/NFC and connectivity acceptance remain unverified. Phase1 predecessor is archived with deployed evidence in docs/0098-phase-one-acceptance.md.

Verify that the pilot can operate and recover on customer hardware and production infrastructure.

## 2. Acceptance Criteria

- [ ] Tablet/browser resolutions and kitchen/bar displays pass.
- [ ] QR/NFC identifiers resolve correctly on physical devices.
- [ ] Receipt and kitchen print jobs pass; physical paper output has on-site evidence.
- [ ] Wi-Fi interruption and reconnection behavior matches the agreed pilot scope.
- [ ] A recent encrypted database backup and checksum are verified.
- [ ] The latest isolated restore check is verified.
- [ ] Encrypted backup retrieval from an off-VPS location is demonstrated.
- [ ] Uploads and essential server configuration have a recovery plan.
- [ ] Monitoring reaches a named operator through a tested alert.
- [ ] TLS and disk usage are within safe thresholds.
- [ ] Code and database rollback steps are documented and rehearsed safely.
- [ ] RPO, RTO, escalation owner, and restart instructions are recorded.

## 3. Safety Constraints

- Production diagnostics are read-only by default.
- Do not trigger failure alerts, restores, rollbacks, or deployment without explicit human approval.
- Never print secrets, environment contents, customer data, or backup keys.

## 4. Testing Instructions

Automated checks may validate health, print-job APIs, backup metadata, restore logs, TLS, and disk usage. Physical printing, device setup, and network failover require an operator-signed checklist.

Pass when automated evidence and required on-site evidence are both attached to the test report.

## Status Tracker

| Phase | Status | Notes |
|---|---|---|
| Created | Complete | |
| Prerequisite | Passed | Phase 1 archived |
| Implementation | In progress | Tablet inventory checked; operational and physical acceptance pending |
| Testing | Pending | |

