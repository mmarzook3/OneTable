# Scanaki recovery and release gate

## Release

Use mmarzook3/OneTable, development -> master via a pull request. Keep the legacy origin remote unchanged for upstream reference. The legacy daily promotion script refuses to promote this checkout. Release checks run backend regressions and an Angular production build; deployment depends on the same reusable workflow.

## Verified checkpoint, 2026-09-07

- Latest daily encrypted backup was approximately 18 hours old; SHA-256 matched.
- Isolated restore passed: 2 tenants, 5 locations, 42 ordering points, 79 schema tables. Temporary restore database is removed by the existing script's cleanup trap.
- Disk usage: 79%, approximately 21 GB available.
- Daily backup at 02:20 UTC, weekly restore at Sunday 03:35 UTC, health checks every five minutes.
- SMTP delivery from support@scanaki.uk to alerts@scanaki.uk and delivery to a group member confirmed by the operator.

## Code rollback

1. Stop additional deployments. Identify the last verified SHA and the failed release from release-commit.txt and GitHub deployment evidence.
2. Preserve a fresh encrypted database backup, customer uploads and server configuration before rollback. Keep keys outside logs and the repository.
3. Compare migrations between the releases. Do not run old code against an incompatible schema. Prefer a forward fix when writes have occurred after the deployment.
4. For a schema-compatible rollback, revert the faulty change on development, run release checks and merge a recovery PR to master. This preserves history and deploys through the guarded workflow.
5. Verify /api/health, /api/health/ready, the public browser baseline, affected authenticated flows, payment reconciliation and service logs before reopening service.

## Database recovery

Run scripts/scanaki-restore-check.sh against a chosen encrypted backup in an isolated database first. Source the existing protected /etc/scanaki/ops.env without printing it. Never restore over the live database as a verification test.

For an actual database-loss incident, the operator must approve the restore point and expected lost transactions. Stop order intake, preserve the damaged database, restore into a new database, validate schema and tenant isolation, then switch the application connection during a controlled maintenance window. Reconcile provider payments since the restore point before resuming orders. Do not blindly replay payments or allocate duplicate orders.

## Remaining disaster-recovery work

The database backup alone does not restore uploads, server configuration, certificates or encryption keys. Off-VPS replication to the approved Scanaki/Backup Drive destination and a full recovery rehearsal must be evidenced before claiming complete disaster recovery. RPO 24 hours and RTO 4 hours are targets, not measured guarantees.
