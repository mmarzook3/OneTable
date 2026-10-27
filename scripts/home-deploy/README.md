# HOME deployment installation and acceptance

This replaces only the legacy GitHub VPS application deployment. It never executes
commands against the old VPS application containers or changes ingress. Production
is `ubuntu-apps-01`, `/opt/projects/scanaki/compose.json`, project `scanaki-home`.
The workflow stays disabled until provisioning and acceptance below are completed.

## Credentials and transport (operator provisioned)

Create two fresh Scanaki-only SSH keypairs; do not reuse management, relay, or other
project credentials. GitHub environment `scanaki-home` secrets:

- `SCANAKI_HOME_JUMP_KEY`: dedicated VPS jump private key.
- `SCANAKI_HOME_CI_KEY`: dedicated HOME forced-command private key.
- `SCANAKI_HOME_KNOWN_HOSTS`: verified host-key entries for both actual destinations,
  including `[host]:port` for nonstandard ports; obtain fingerprints out of band.

Runtime marketing/APK assets use the own-repository release snapshot pinned by
`config/scanaki-runtime-assets.json` (`release_tag`, `asset`, `sha256`). The built-in
`GITHUB_TOKEN` needs only contents-read; no cross-repository marketing token is used.
The tar/tar.gz archive contains only regular files/directories under `sites/` and
`downloads/`. Hash, paths, links, required marketing indexes/placeholders and APK
presence are checked before copying into `front/sites` and `front/public/downloads`.

Repository variables: `SCANAKI_HOME_JUMP_HOST` (VPS address),
`SCANAKI_HOME_SSH_HOST` (HOME address reachable FROM VPS over the private network),
`SCANAKI_HOME_SSH_PORT` (explicit port). There is no assumed public HOME SSH port.
The current HTTP relay on18220 is NOT SSH. Do not reuse its account/key or alter it.
Verify VPS-to-HOME private SSH reachability before enabling CI; if unavailable,
provision a separate Scanaki-only private SSH transport with owner approval.

VPS account `scanaki-ci-jump`: dedicated key, no password, PTY, agent/X11 forwarding,
remote forwarding, or shell/session (`MaxSessions 0`); permit local TCP forwarding
ONLY to the exact HOME SSH host:port (`AllowTcpForwarding local`, `PermitOpen`).
An authorized-key `restrict,port-forwarding,permitopen="HOST:PORT"` restriction
must be combined with those server-side restrictions (especially no remote forwards).

HOME account `scanaki-ci`: no Docker group, no writable deployment/config paths,
no password or forwarding. Its authorized key uses:

For a root-owned HOME account directory, keep `.ssh` root-owned0755 and its
public `authorized_keys` root-owned0644: sshd must read it as the account, while
only root may modify it. Private keys remain outside HOME and outside Git.

```
restrict,command="/usr/local/lib/scanaki-home-deploy/forced-command.sh" ssh-ed25519 PUBLIC_KEY
```

Root-owned sudoers file, validated with `visudo -cf` before activation:

```
scanaki-ci ALL=(root) NOPASSWD: /usr/local/lib/scanaki-home-deploy/receiver.py *
```

The receiver accepts one exact argument with strict protocol validation; it never
evaluates SSH command text as a shell. No `sudo docker`, shell or arbitrary
`systemctl` permissions. Uploaded code cannot replace the installed executor.
Treat this deploy key as authority to ship production application code.

## Root installation (primary/operator only)

Review/install `receiver.py`, `executor.py`, `forced-command.sh` to
`/usr/local/lib/scanaki-home-deploy/`, root:root, directory755, files755, LF endings.
Install `scanaki-home-deploy@.service` to `/etc/systemd/system/`, root:root644;
`systemctl daemon-reload`. Create `/var/lib/scanaki-home-deploy`, root:root700.
Python3.10+ standard library, Docker Compose v2 and existing native
`scanaki-home-backup.service` are required; no runner or build tools on HOME.
No dependencies are installed by this repository workflow.

Before installation confirm: linux/amd64; five service names
`back/front/ws-bridge/db/redis`; all have working healthchecks; root-owned private
Compose is JSON, image-only, and private bind paths remain valid independently of
release sources. Audit mounts so none mask application code inside the new images.
Existing `safe_start.py` must remain mounted/commanded exactly as approved.
Confirm front host-owned Nginx config/aliases work with the current production
Dockerfile; confirm migration entrypoint `python -m app.migrate` uses the existing
private DB environment. Executor allows source `https://github.com/mmarzook3/OneTable`
only. Changing repository requires operator review of this installed constant.
Ensure at least8GiB free for load/backup, plus image growth headroom; no automatic
image pruning or encrypted-backup retention is performed.

The existing native backup must fail on any incomplete database/config/upload
backup, with successful completion recorded by systemd. Executor requires a new
successful invocation, not a cached success or a concurrent timer run.

## Execution and recovery

CI builds linux/amd64 images from the checked-out SHA after the preserved backend
tests and Angular production-static build. Pinned runtime assets are fetched from
the same repository and placeholder-checked. BuildKit dependency-layer caches use separate verification
and privileged HOME scopes; lockfile/requirements changes invalidate layers.
The bridge build combines the existing backend and bridge Dockerfiles, preserving
their base relationship without a registry or HOME build.

SSH protocol: `submit <40 lowercase hex SHA> <64 lowercase hex SHA256>` streams
a Docker-save archive on stdin (maximum4GiB). `status <SHA>` returns only a status,
never logs/configuration. Interrupted uploads never become deployable. Revision
directories are immutable; duplicate submissions are rejected for operator review.
Full archive checksum, exact three tags, OCI source/revision labels, architecture
and final running image IDs are checked. CI SSH authentication is the provenance
trust boundary; labels alone are not an independent signed attestation.

The receiver starts `scanaki-home-deploy@SHA.service` without waiting. Its durable
root process serializes changes with flock. Queued superseded releases skip before
mutation; an active release completes even when CI cancels. CI timeout is NOT proof
of deployment failure: inspect status/journal before retrying. An executor/host
crash during mutation requires operator review; no boot-time automatic replay.

Before mutation: all five services healthy, private HTTP probes pass, disk guard,
image validation, fresh native encrypted backup, private Compose snapshot at
`/var/lib/scanaki-home-deploy/SHA/compose.before.json`. The three image fields change;
each explicit Compose `user` is retained. When `user` is absent, a nonempty current
container `Config.User` is copied into the candidate service, so an inherited
`1000:1000` identity cannot become root when a new image omits USER. Before backup
or stopping writers, isolated read-only/no-network candidate containers resolve
the selected user and must match the current container's numeric UID and GID.
They also check readable application files and Python dependencies (or frontend
HTML/nginx executable). Missing users, changed name-to-ID mappings, unreadable
files or failed imports block deployment. This does not prove runtime bind-mount
write access or full startup; existing health checks and live acceptance remain
required. Migration containers inherit the same preserved Compose user.
Commands, safe_start, mounts, volumes, networks, extra_hosts (including
`smtp-relay.gmail.com:10.77.0.1`), environment and DB SMTP port2587 remain intact.
All three app writers stop before both migration commands. DB/Redis and ingress
are never restarted. App services restart with no dependency recreation/pull/build.
Private HTTP/all-service health, exact running image IDs and recent logs must pass;
CI subsequently checks public HTTPS health and landing version metadata.

A failed live mutation writes `recovery-required`, blocking later submissions from
mutating HOME. Do NOT restore old images or an old database blindly: migrations
may be incompatible and writes may have occurred. Inspect private journal/logs,
record schema/data state, quiesce writers if necessary, and choose a forward repair
or an explicitly approved restore. Retain image tags and native backup plus private
Compose snapshot. Remove the recovery marker only after health/data validation.
VPS old writers must remain stopped. Operator restart of the same service requires
the same review; it is not a safe automatic retry interface.

## Enablement and tests

Offline: `python -m unittest discover -s scripts/home-deploy -p 'test_*.py'`.
Validate both shell scripts with `bash -n`; parse workflow YAML separately if the
local Python lacks PyYAML. No local Docker or live action is needed for these checks.

Before setting repository `SCANAKI_HOME_DEPLOY_ENABLED=1` and re-enabling the legacy
disabled workflow, primary must test dedicated SSH shell/forwarding denials, valid
status, a broken upload (no unit starts), backups and a supervised exact-revision
release. Verify public login, QR/order and WebSocket flows, SMTP fixed-route
preservation, five healthy HOME services and stopped old VPS writers. Cancel the
observer after submission during a controlled acceptance run and confirm HOME
finishes independently. Do not claim these live tests from offline unit results.

Push allowlists exclude unrelated docs; dispatch requires explicit opt-in and
deployment requires current protected master. Reusable checks require eligibility
from the caller. The required PR job always reports; its in-job positive allowlist
skips builds for docs-only PRs. API failure fails the check; truncated file lists
run the full checks. SSH multiplexes both hops and polls status every30 seconds.
Use protected `master` and the `scanaki-home` environment for deployment access.
