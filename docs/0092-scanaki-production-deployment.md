# Scanaki production deployment

Production deployments take an exclusive host lock at
`/run/lock/scanaki-production-deploy.lock`. CI and manual runs must use
`scripts/deploy-scanaki-production.sh`; a second deployment exits with code 75 instead of
starting another Angular/Docker build. The script also refuses to build with less than 2 GiB
available memory, preventing host-wide resource exhaustion.

After replacing Scanaki containers, deployment validates and reloads the existing shared
edge proxy (`mesher-iot-platform-phase0-nginx-1` by default). This forces Nginx to resolve
the new `scanaki-front` container address before public health checks, preventing stale
upstream `502` responses after a container recreation.

## Production contract

- GitHub repository: `mmarzook3/OneTable`
- Production branch: `master`
- Workflow: `.github/workflows/deploy-scanaki-production.yml`
- VPS application directory: `/opt/scanaki/app`
- Release staging directory: `/opt/scanaki/releases/<git-sha>`
- Public liveness URL: `https://scanaki.uk/api/health`
- Public readiness URL: `https://scanaki.uk/api/health/ready` (checks PostgreSQL and Redis)
- Compose project: `scanaki_prod`, defined by the server-owned `docker-compose.scanaki.yml`

The production directory is an rsynced release and deliberately has no `.git` directory. Do not restore the old `amvara9` Git-fetch deployment steps: they target a different server, repository and compose layout.

## GitHub configuration

Required repository secrets:

- `SSH_PRIVATE_KEY_SCANAKI`
- `SCANAKI_DEPLOY_HOST`
- `SCANAKI_DEPLOY_USER`

Repository variables:

- `SCANAKI_DEPLOY_PORT` (currently `22`)
- `SCANAKI_DEPLOY_PATH` (must be `/opt/scanaki/app`)
- `SMOKE_TEST_BASE_URL` (currently `https://scanaki.uk`)

The CI public key must remain in the deployment user's `~/.ssh/authorized_keys`. Rotate the key by installing a new public key first, updating `SSH_PRIVATE_KEY_SCANAKI`, testing a manual workflow run and then removing the old public key.

## Files CI must never replace

The workflow verifies and preserves these server-owned files and directories:

- `config.env`
- `.secrets`
- `deployment-secrets.env`
- `docker-compose.scanaki.yml`
- `nginx.scanaki.conf`
- `data/`
- `backups/`
- `certbot/`
- `android/scanaki-kitchen/signing/`

The workflow refuses any deployment path other than `/opt/scanaki/app`. Deployment commands use only the `scanaki_prod` compose project and do not enumerate, restart or remove other Docker projects on the VPS.

## Deployment sequence

1. Checkout the exact `master` revision.
2. Validate required secrets and the fixed deployment path.
3. Fetch current marketing artifacts.
4. Upload the source tree to an immutable SHA-named release directory.
5. Synchronise that release into `/opt/scanaki/app` while preserving server state.
6. Create an encrypted PostgreSQL backup.
7. Build new Scanaki images while the current containers remain online.
8. Run strict database migrations.
9. Replace only the `scanaki_prod` containers.
10. Run idempotent demo and Yew Trees seeds.
11. Run internal health, reconciliation, backup-age, TLS and disk checks.
12. Run public landing-page and API smoke tests from GitHub Actions.
13. Retain the five newest uploaded release directories.

GitHub Actions serialises production runs. When several `master` commits arrive
quickly, a queued run checks the current `master` SHA and exits successfully if
it has already been superseded. The server deployment script also takes
`/run/lock/scanaki-production-deploy.lock`, preventing CI and documented manual
deployments from building or migrating concurrently. Back, WebSocket and front
images are built sequentially to reduce peak VPS load.

## Manual verification

```bash
gh run list --repo mmarzook3/OneTable --workflow deploy-scanaki-production.yml --limit 5
gh run view <run-id> --repo mmarzook3/OneTable --log-failed
curl --fail https://scanaki.uk/api/health
curl --fail https://scanaki.uk/api/health/ready
```

Use `workflow_dispatch` to test CI without manufacturing an empty production commit. A failed image build or migration does not remove the existing database or current application containers; the workflow prints Scanaki-only container status and recent application logs for diagnosis.
