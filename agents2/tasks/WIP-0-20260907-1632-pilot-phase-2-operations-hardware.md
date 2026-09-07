# Pilot phase 2: operations and hardware

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 2 operations and hardware
- **URL:** None
- **Labels:** pilot-readiness, phase-2

## Meta

- **Status:** `in-progress`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** Verified Phase 1 task archived under `agents2/tasks/done/`
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## Dependency Gate

Do not rename this task or edit application code until Phase 1 is verified and archived. If it is missing, record the blocker and exit.

## 1. Objective

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

