# Phase 0 acceptance evidence

Date: 2026-09-07. Scope: release and public browser test foundation, with recovery readiness assessment. This is not acceptance of the full customer transaction or disaster recovery.

## Verified

- Containerized Chromium baseline builds and runs independently of the application frontend.
- Public baseline passed on localhost and https://scanaki.uk: liveness, database/Redis readiness, mobile navigation, footer scroll, version, demo card and API docs.
- Corrected live CSP allows only the two required Google Fonts hosts. Production browser rerun emitted no font CSP errors.
- GitHub release checks passed on development and pull request revisions. Checks run backend tests in Docker and an Angular production build.
- Master protection enforces PRs and the release-checks context, strict base synchronization, administrator enforcement, no force push and no deletion.
- Manual production dispatch refuses a non-master ref; stale master revisions are skipped. Deployment depends on reusable release checks.
- Sync selects the approved Scanaki repository. Legacy promotion refuses the fork regardless of remote alias.
- Daily encrypted backup within 24h, checksum matched. Fresh isolated restore passed with 2 tenants, 5 locations, 42 ordering points and 79 schema tables.
- Disk usage 79%, 21 GB available. Scheduled health check and payment reconciliation successful.
- Direct SMTP and group-to-member inbox delivery confirmed by the operator.
- Recovery procedures and limitations documented in docs/0095-scanaki-recovery-runbook.md.

## Production release

PR: https://github.com/mmarzook3/OneTable/pull/1

Merge SHA: 114e73186c6cf37caf57af6317bc57c9e53a256c

Deployment: https://github.com/mmarzook3/OneTable/actions/runs/34160371260

Deployment succeeded. Post-deployment public browser baseline passed and displayed the exact merge SHA. All five Scanaki containers are running; backend, PostgreSQL and Redis report healthy. Recent scoped service logs contain no matched traceback, fatal, emergency, uncaught exception or bundle-generation failures. Phase 0 acceptance: PASSED for its documented scope.

## Phase 2 follow-through

Off-VPS backup replication, uploads/configuration recovery, a full-host recovery rehearsal and measured recovery targets remain outstanding. Existing encrypted database backup restoration does not establish these outcomes.
