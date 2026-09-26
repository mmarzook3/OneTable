# Phase 4 engineering acceptance and final handoff

Date:2026-09-09.

**Engineering result: PASS / complete. Final customer-launch decision: NO-GO until
the deferred physical checks and customer onboarding are accepted.** This is the
split gate the user requested, not a claim that physical tests already passed.
This record supersedes the open tooling findings in records0111 through0116.

## Release identity

- Running application:2.2.3, `d23e7e68e48cf1ae51064b117804d5a3f690f204`.
- Protected promotion: https://github.com/mmarzook3/OneTable/pull/16
- Successful deployment: https://github.com/mmarzook3/OneTable/actions/runs/34298482748
- Cash/KDS application correction: `7794423ea`.
- Guarded transaction tooling: `c9febee12`.
- Recovery/rollback tooling: `a2ab7835d`.

Tooling was deployed and exercised separately under the approved test-tooling
exception; it does not change the running application's release identity.

## Verification completed

| Area | Evidence | Result |
| --- | --- | --- |
| Payment/KDS regression | 37 backend tests and26 subtests locally and against the deployed immutable VPS image | PASS |
| Complete local transaction | Creation/idempotency, cash700, kitchen/bar routing, preparation/completion, receipt/PDF, sales1/700 | PASS |
| Complete VPS transaction | Same seven functional checks; tenant45/order174 removed afterward | PASS |
| Request safety | Deliberate popup write blocked; token-bearing path redacted; external probe blocked by interception locally and enforced CSP on VPS | PASS |
| Seed recovery | Preparation precedes commit; lost/malformed responses and interruption recovery; guarded repeated cleanup | PASS |
| Current application recovery | Fresh encrypted bundle restored in isolated containers; startup, health/docs/OpenAPI and authenticated read APIs | PASS |
| Recovered data/config | Manifest verification,11 upload hashes and12 in-memory ciphertext decryptions with recovered crypto key | PASS |
| Recovery browser | Current and preserved frontend login forms rendered; three authenticated GETs each | PASS within read/render scope |
| Recovery privacy | No published ports or external network; disabled container logs; nginx read-only rootfs/tmpfs;12,058,624-byte synthetic proxy response verified without disk spill | PASS |
| Rollback safeguards | 139 credential/excluded-path hashes preserved; stale ordinary files removed; case variants, archive/alias and volume guards | PASS |
| Rollback rehearsal | Baseline captured; isolated candidate-to-baseline containers replaced and cleaned | PASS within stated scope |
| Operational checks | Public browser smoke, readiness, reconciliation, affected-service logs, TLS and disk | PASS |

The VPS transaction reported zero browser exceptions. Its one blocked write was
the intentional guard probe; no unexpected write was permitted. The external
probe was denied by a matching enforced CSP violation before interception. Known
font downloads stayed blocked; unknown external requests still fail acceptance.
Physical printing was suppressed. No real card charge, customer email or live
rollback occurred in these rehearsals.

The earlier receipt initialization error was a null navigation response. The
harness now retains the existing document's security headers for same-document
navigation. The guarded popup is brought forward before render waits. Earlier
failed attempts are not counted as passing evidence.

## Recovery scope and limits

The fresh source was the approved Drive-mounted copy of
`scanaki_recovery_20260909_022004_ffaf1e9413e4`, transferred to the VPS by SCP and
verified. This was not an API-stream download. Recovered configuration was
verified, not sourced wholesale; provider/mail credentials were not activated.
Only the recovered crypto key was used privately for ciphertext checks. Runtime
authentication used synthetic signing keys and a restored owner's read session.

The recovery browser checks do not prove restored-user password login or a
different-version backend downgrade. The full cash transaction was separately
verified against the deployed application. Bare-VPS provisioning, shared-edge
rebuild and operator response time were not rehearsed; no outage-wide RTO is
claimed from component timings. Existing approved recovery targets remain
operational targets. A checkpoint-junction negative test was unavailable; actual
checkpoint paths passed confinement checks and traversal/alternate-stream tests.

## Captured rollback baseline and operator command

Baseline directory:
`/opt/scanaki/app/backups/rollback-baselines/d23e7e68e48cf1ae51064b117804d5a3f690f204`

Independently recorded core manifest SHA256:
`0e0787fa939136949139fd852d9e90e723f7ba75572398b3ebd6525bff1542e5`

The baseline contains source and all three application images plus configuration
hashes and the schema fingerprint. The root `agents -> agents2/` alias is preserved
through exact allowlisted metadata; arbitrary source/archive links remain refused.
Auxiliary operator scripts are preserved inside the protected baseline directory,
outside the sealed core manifest, so source replacement cannot remove them:

- `phase4-rollback-rehearsal.py`: `1c086ab8f25fcc07c15d35f86dc436fddf106eaaa0b5a454c8433c2db4c748e2`.
- `scanaki-rollback-baseline.sh`: `86fd72b25e11646b613e01d728d5f63bdc238a30e73b82958be9ffcef7d091a1`.

The verified isolated command, after a real deployment freeze and active-run drain:

```bash
bash /opt/scanaki/app/backups/rollback-baselines/d23e7e68e48cf1ae51064b117804d5a3f690f204/scanaki-rollback-baseline.sh rehearse \
  --execute --expected-current-sha d23e7e68e48cf1ae51064b117804d5a3f690f204 \
  --baseline-sha256 0e0787fa939136949139fd852d9e90e723f7ba75572398b3ebd6525bff1542e5 \
  --deployments-paused
```

For an explicitly approved future incident, the implemented `rollback` action also
requires `--allow-live-cutover` and the independently checked incident release SHA
as `--expected-current-sha`. Do not substitute an unverified value or claim a freeze
without stopping deployment writers. It requires backup success and exact schema/
configuration compatibility, restores protected source/image pins, replaces only
application services, reloads the edge and checks health. It never downgrades or
restores the live database. Schema/configuration mismatches require a separately
reviewed recovery plan. Verify transactions before reopening service.

Operator: the primary engineering operator under the user's recorded authority;
production approval authority remains in tracker P0-03, with escalation through
`alerts@scanaki.uk`. The live cutover command was not executed. The isolated
replacement used the same known-good image pins for its candidate simulation;
it proves replacement mechanics, not compatibility with an arbitrary future
release. The separate application-recovery checks establish the tested baseline.

GitHub production deployment was temporarily disabled for capture/rehearsal,
active runs were drained, master was unchanged, and the workflow was restored to
active in `finally`. Monitoring and backups were not disabled. The preserved
wrapper's default no-op behavior was tested after Linux newline normalization.

## Backup and operations

Fresh02:20UTC database and complete recovery bundle were transport-checksummed and
separately confirmed in Drive. The nonsecret transfer record has
`cloudVerified=true` for that exact set; local mount presence alone was not used.

- Database: `scanaki_20260909_022002.sql.gz.enc`, Drive ID `1uOP8GOflgofG3MrNj0kxt43VmCmsWHQE`.
- Database checksum: `1g-zHYhOonZn3Q6Lp5cf0GwyUFMP9C6jc`.
- Complete-set folder: `1GqSC9M2B0AZnesSmtg4Ums1UpLIuC3u1`.
- Bundle/checksum: `1CVkdbqj-Mzh9RO1_vQUrdPuZAi-SK_v5` / `1kGahpc0xkmjJJgVCnjC3LJhNp1WRfw2f`.

All five production services remained running; backend/database/Redis reported
healthy. Final operations health and reconciliation passed; disk78%. TLS was
validated with expiry2026-11-21T23:15:27Z. The earlier operator-confirmed alert-group
delivery evidence is retained; no repeat email was sent. No rehearsal containers
remained. Rollback source/image archives are preserved on the VPS; this record
does not claim they have been copied offsite. Application source is also in GitHub.

The offsite-copy process still depends on the laptop, Drive mount and signed-in
application. The recovery key remains in the approved Git-ignored local `.env`;
its plaintext/laptop dependency is unchanged. Recurring backup protection must
continue while final acceptance is pending and after engineering completion.

## Final operator acceptance still required

Complete the one agreed on-site session:

- P2-07: physical receipt and kitchen-ticket paper output.
- P2-08: spare NFC tag write and read-back to the correct table/menu.
- P2-09: camera permission and printed QR plaque scan.
- P2-10: venue Wi-Fi interruption/recovery and ticket reconciliation.

Customer Stripe onboarding remains the customer's responsibility under P1-05.
Before enabling/accepting live card service, confirm live configuration and the
controlled payment/refund result. P1-06 records a GBP50 maximum, not proof that a
live test occurred. Scanaki's own SaaS collection remains bank transfer; platform
Stripe stays deferred. Warehouses remain deferred and fiscal integrations excluded.

Do not mark these operator checks passed from engineering evidence or enable
customer go-live automatically. Once their explicit evidence is recorded,
reconcile the then-current release before issuing final GO.

Detailed local evidence: `tmp/phase4-transaction-vps.json`,
`tmp/phase4-transaction-vps-cleanup.json`, `tmp/phase4-app-recovery-final.json`,
`tmp/phase4-rollback-final.json`, and the independently recorded baseline identity.
