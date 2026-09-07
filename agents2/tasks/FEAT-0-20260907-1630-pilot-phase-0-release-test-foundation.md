# Pilot phase 0: release and test foundation

## Checkpoint 2026-09-07

Implementation commits: 0fdc54e02, 56ad72f94, 8d31291e7. Release PR: https://github.com/mmarzook3/OneTable/pull/1.

The standalone browser image and public baseline pass locally and on production. The readiness assertion now checks the real API contract. The live server-owned CSP was fixed, the frontend container recreated, and the shared edge reloaded; the subsequent live browser baseline reported no CSP font errors. Production master requires the release-checks status, PRs, no force push/deletion, and applies restrictions to administrators. A reusable release workflow runs backend regressions and the production Angular build before deployment. The sync helper uses scanaki; the legacy promotion helper refuses this fork.

Backup SHA-256 verified, latest backup within 24h. Fresh isolated restore passed (2 tenants, 5 locations, 42 points, 79 schema tables). Cron health and payment reconciliation pass. Disk 79%, 21 GB free. Operator confirmed direct and group SMTP inbox delivery. Recovery procedure: docs/0095-scanaki-recovery-runbook.md.

Do not close until release PR checks and deployment are complete. Offsite replication and full-host recovery rehearsal remain Phase 2 requirements; their absence is explicitly documented, not treated as verified recovery.

## GitHub Issue

- **Number:** 0
- **Title:** Pilot phase 0 release and test foundation
- **URL:** None
- **Labels:** pilot-readiness, phase-0

## Meta

- **Status:** `ready-for-dev`
- **Generated:** 2026-09-07
- **Assigned Agent:** `coding-agent`
- **Prerequisite:** None
- **Plan:** `docs/0093-pilot-customer-phased-readiness.md`

## 1. Objective

Create a repeatable, safe test foundation and remove release ambiguity before pilot feature work proceeds.

## 2. Acceptance Criteria

- [ ] `mmarzook3/OneTable` is documented and configured as the pilot release source without merging the divergent legacy history.
- [ ] Production `master` protection and deployment gating are documented; any external settings change waits for human approval.
- [ ] A separate browser-test image/profile provides pinned Chromium without adding Chromium to the production frontend image.
- [ ] Puppeteer receives a consistent Linux executable path and headless configuration.
- [ ] One `pilot-smoke` runner executes only safe, repeatable checks and stops on the first failure.
- [ ] Rate-limit, registration, email, production mutation, and live-payment tests are excluded from the safe suite.
- [ ] Current backup, restore-check, TLS, disk, monitoring, and rollback gaps are reported with no secrets.
- [ ] Tests and frontend logs pass.

## 3. Implementation Scope

**In scope:**

- A dedicated test Dockerfile and Compose test profile/overlay.
- A pilot smoke runner and minimal documentation.
- Stabilizing only the browser scripts selected by the safe gate.
- Release-line and rollback documentation corrections.

**Out of scope:**

- Production deployment or `master` promotion.
- Real payments, refunds, emails, or persistent production records.
- Rewriting all Puppeteer scripts.
- Adding Chromium to production images.

## 4. Suggested Files

- `front/Dockerfile.test`
- `docker-compose.test.yml`
- `scripts/test-pilot-smoke.sh`
- `front/scripts/puppeteer-headless.mjs`
- `docs/testing.md`
- Release and deployment documentation where current remote names conflict

## 5. Testing Instructions

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.test.yml build browser-test
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.test.yml run --rm browser-test
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs --since 10m --tail=120 front
```

Pass when the image is reproducible after recreation, the safe suite passes, no Angular compiler error appears, and no production mutation occurs.

## Status Tracker

| Phase | Status | Notes |
|---|---|---|
| Created | Complete | Dependency-free first phase |
| Implementation | Pending | |
| Testing | Pending | |
| Human release review | Pending | Required before production changes |
