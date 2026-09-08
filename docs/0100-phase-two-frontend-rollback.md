# Phase 2: previous frontend recovery and rollback rehearsal

Completed on 2026-09-08. Owner: isolated recovery investigation. The primary
agent owns review and commit of this document. No application source, live
container, live database, deployment configuration, or production volume was
changed by this rehearsal.

## Result

PASS for recovery of the previous frontend's compiled static output and HTTP/API
compatibility against an isolated database restored from the offsite bundle.
The previous frontend was recovered from existing Docker build cache, so no
compilation, dependency installation, image pull, or production build was needed.

| Check | Observed result |
| --- | --- |
| Previous release | `7a3e0cbd21e32347c85ee1eb05457ba674c1f382` |
| Current release used for compatibility comparison | `985b98e35543f8495f4f283eeedd96c84d980c0d` |
| Previous compiled output | Cache snapshot `16892`, with version-injected index from `16893` |
| Embedded previous release marker | Found in `chunk-4DA2H7MQ.js` |
| Database restore | 79 public tables, SQL restore with `ON_ERROR_STOP=1` |
| Old frontend artifacts | All 187 files returned HTTP 200 and matched their SHA-256 hashes |
| Entry-point references | All 5 referenced local JS/CSS entries resolved |
| SPA HTTP routes | `/`, `/login`, `/book/1`: HTTP 200 |
| Proxied API | `/api/health`, `/api/public/legal-urls`: HTTP 200 |
| API schema | `/api/openapi.json` loaded; 350 paths, including checked health/legal operations |
| Container logs | Zero matched database, API startup/migration, or nginx error markers |
| Network isolation | Only loopback interface; zero routes; no published ports |
| Cleanup | Three containers and one dedicated database volume removed; zero remaining project resources |

This is an HTTP/static artifact and OpenAPI compatibility test. It does not claim
browser JavaScript execution, interactive login/booking acceptance, production
TLS/proxy validation, external integrations, or recovery of the original previous
OCI image. The previous static output ran on the existing nginx runtime with a
temporary, isolated proxy configuration.

## Measured recovery time and backup age

| Measurement | Value |
| --- | --- |
| Start marker | Isolated PostgreSQL container `Created` timestamp |
| Start UTC | `2026-09-08T12:04:41.146964759Z` |
| Successful smoke completion UTC | `2026-09-08T12:05:02.191518+00:00` |
| Measured restore-to-smoke elapsed time | **21.045 seconds** |
| Source database backup | `database/scanaki_20260908_112910.sql.gz.enc` |
| Backup timestamp UTC, from backup filename | `2026-09-08T11:29:10+00:00` |
| Selected backup age at restore start | **2,131.147 seconds: 35 minutes 31.147 seconds** |

The measured interval includes isolated PostgreSQL initialization, SQL restore,
API startup, old frontend startup, and successful asset/API checks. It excludes
offsite retrieval, decryption, investigation, operator decision time, and
production traffic cutover. It is a measured recovery execution interval, not an
end-to-end production outage RTO. The backup age is an RPO-related observation
for this selected recovery point, not measured lost transactions or proof of the
recurring backup schedule's SLA. The filename timestamp is not an independently
measured transaction snapshot timestamp.

## Recovery source and backend compatibility

The encrypted bundle and sidecar were retrieved through the approved mounted
Google Drive path and copied to the VPS with SCP:

```text
G:\My Drive\Scanaki\Backup\scanaki_recovery_20260908_113237_689606929b7a\bundle.tar.enc
```

This was Drive-mounted retrieval, not the direct Drive API media download.
The bundle was 1,955,872 bytes and matched its sidecar:

```text
SHA256 6e8ebbe7ca854e21af6c630502d6b4615b0e4038dff28ee9b03f92787ae754f4
Drive bundle ID: 1HApWwbJN9vD_ZkqX8tDdSeYew0GT_yFY
Drive checksum ID: 1-e0ZyNG7mIJGQo5ETnBUwop1NHSTNUkm
```

Decryption used `/etc/scanaki/ops.env` without printing secret values. The restored
database ran under project `scanaki-old-front-rehearsal-20260908`, with a new
volume and `--network none`. The API and frontend shared only that isolated
network namespace. API configuration files were masked and synthetic settings
were supplied. Neither production databases nor outbound integrations were
reachable from the test containers.

The preceding application recovery rehearsal compared 395 Python, SQL,
`requirements.txt`, and Dockerfile files across the previous release, current
release, and this immutable backend image; all matched:

```text
Backend image:
sha256:2dfe2cbbc94e2b9147199c19d03a12bab85b567369398af8c0dedcb1e349d90a
Backend file-manifest SHA256:
90d76e8f8d68d7da81d8dbb5271550cf94a83dc8d0df37d98919f9b691e1ec4d
```

That earlier test also read all 68 ORM tables, verified all 11 restored uploads,
and restarted the identical backend with unchanged schema version
`20260907190000`. Consequently the old frontend test exercised the same backend
implementation as the previous release. This compatibility conclusion applies
to the tested release pair; it must not be assumed for future schema changes.

## Preserved artifacts and hashes

The recovered static files are retained as a recovery artifact, outside `app/tmp`:

```text
/opt/scanaki/app/backups/recovery/scanaki_frontend_7a3e0cbd_20260908.tar.gz
Size: 36412708 bytes
SHA256: 4c11c7b2d50431178f105ae58d7590b23b28bacaabe809e686c9dba6356fb8c5
```

The adjacent `.tar.gz.sha256` sidecar records the archive checksum. The complete
187-file hash manifest is
`/opt/scanaki/app/backups/recovery/scanaki_frontend_7a3e0cbd_20260908.manifest.json`.
Its SHA-256, calculated over the canonical sorted JSON produced by the rehearsal,
is `af5aa3359db5d6d73b000c0b84a4f0d7fa14f04cf35284305d56d4e19cc7dd21`.

| Artifact | SHA-256 |
| --- | --- |
| `index.html` | `08f9ed0958eecacff83ed0f2ef7310e7810523a8091909851e8deb450d6f8209` |
| `runtime-config.js` | `20bcb5eb1d01a112a3bd27daf55a8563d73117e72e76708c2125586207755d11` |
| `styles-XOUFHQVM.css` | `cd72e5b7f5e666886e831c6bcd5d61baab51e274ca2b226273a7ab089548fb6e` |
| `polyfills-5CFQRCPP.js` | `15c6f58707b9b19116fde3a3f6a0ce9cf83427d64a91e95cb91fe1056c3da616` |
| `main-SCJQQKUB.js` | `4be26b8043738cea3546c23cfc36af7986316fbb328c14181765135cdd2be416` |
| `chunk-4DA2H7MQ.js` | `f8397f2253a3a2cbabe5306e1b2dd7bf96fe0a7c764a8187afff3d5144404904` |

Sanitized machine-readable evidence is retained at:

```text
VPS: /opt/scanaki/app/backups/recovery/scanaki_frontend_7a3e0cbd_20260908.evidence.json
Local: tmp/phase2-frontend-rollback-evidence-20260908.json
Local complete hash manifest: tmp/phase2-frontend-rollback-artifact-manifest-20260908.json
Earlier application recovery: tmp/phase2-application-recovery-evidence-20260908.json
```

Production deployment run `34223913813` replaced `app/tmp` after the smoke checks
passed. The final artifact was preserved from the same read-only cache bytes and
checked against the already measured aggregate manifest hash. The deployment
removed the decrypted scratch files; explicit label-checked cleanup subsequently
removed the isolated containers and volume. Durable recovery evidence belongs in
`backups/recovery`, because deployment excludes backups/data but not `app/tmp`.

## Intended operator restart and rollback path

1. Identify the failure and record the currently running frontend/backend image
   digests and schema version. Preserve a current verified recovery point before
   any stateful intervention. A frontend-only incident does not authorize a
   database restore or downgrade.
2. Serialize any production restart, build, or cutover with the normal deployment
   workflow and `/run/lock/scanaki-production-deploy.lock`. Do not overlap an
   active deployment or overwrite an existing live image tag.
3. For a transient process problem, restart only the affected service under that
   lock using the existing reviewed production Compose configuration. Restarting
   an existing container keeps its image; it is not a release rollback.
4. For a frontend rollback, verify the preserved archive sidecar and file
   manifest, then stage `browser/` under a new immutable frontend image/tag using
   the validated nginx runtime. Preserve and validate the reviewed production
   nginx/entrypoint configuration and any required marketing assets. The
   rehearsal's temporary nginx configuration is not a production configuration.
5. Before cutover, run the staged frontend against an isolated recovered database
   and a backend proven compatible with the actual current schema. Repeat the
   root, referenced asset, and API checks. Perform browser and production proxy
   checks appropriate to the incident. Obtain production authorization through
   the established release workflow.
6. Select that verified immutable image in the reviewed release configuration,
   then recreate only the frontend service under the deployment lock. Do not
   restart or recreate database dependencies for a frontend-only rollback.
   Check public responses and container logs immediately, and retain the
   pre-cutover image as the forward recovery option.
7. If schema compatibility cannot be established, stop the application-only
   rollback path and use a separately approved, tested recovery plan. Never run
   `docker compose down -v`, remove live volumes, or restore a dump into the live
   database as an incidental rollback step.

These operator steps document an intended safe path. This rehearsal performed
no production restart, cutover, restore, or rollback.
