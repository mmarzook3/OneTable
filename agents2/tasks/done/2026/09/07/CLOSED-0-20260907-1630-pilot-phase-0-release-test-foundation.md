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

- [x] `mmarzook3/OneTable` is documented and configured as the pilot release source without merging the divergent legacy history.
- [x] Production `master` protection and deployment gating applied under user authorization.
- [x] A separate browser-test image/profile provides Chromium without adding Chromium to the production frontend image. Alpine package updates remain possible on fresh builds; the built image is reusable.
- [x] Puppeteer receives a consistent Linux executable path and headless configuration.
- [x] One public `pilot-smoke` runner executes safe, repeatable checks and stops on failure.
- [x] Rate-limit, registration, email, production mutation, and live-payment tests are excluded.
- [x] Backup, restore, TLS, disk, monitoring and recovery limitations documented.
- [x] Required Phase 0 release checks, production build and live public browser checks pass.

## Test report and closing summary

PASSED 2026-09-07. Full evidence: docs/0096-phase-zero-acceptance.md. Production SHA 114e73186c6cf37caf57af6317bc57c9e53a256c. GitHub deployment 34160371260 succeeded after release checks. Post-deploy public baseline passed; containers running and no matched critical log errors. Independent review findings fixed before merge. Offsite replication and full-host recovery remain Phase 2, and authenticated transaction acceptance remains Phase 1.

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
