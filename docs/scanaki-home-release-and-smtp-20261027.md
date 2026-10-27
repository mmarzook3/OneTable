# Home releases and SMTP repair - 27 October 2026

## Verified outcome

- SMTP root cause: smtp-relay.gmail.com resolved to IPv6 from the VPS; Google
  returned550 invalid relay credentials. Forced IPv4 accepted the same sender250.
- One explicitly labelled test email sent through the application to the alerts
  group was confirmed in the recipient Gmail inbox. No customer email was sent.
- Dedicated IPv4 transport preserves Google's end-to-end STARTTLS certificate
  validation; no new Google credentials or allowlist expansion were needed.
- HOME-only GitHub Actions run40533785314 passed eligibility, required release
  checks, cached image builds, pinned assets, durable deployment and public smoke.
- Deployed revision:35d34c16503c3c01badbcd56e4ad87bd5bb7fe51. All three application
  image IDs/labels matched this revision on home. Backend UID1000:1000 retained.
- Public browser checks9/9 passed after deployment. Synthetic test data cleaned.
- Preserved one restaurant, two users,128 products,38 tables and zero orders.
- SMTP sender remained accepted250 after deployment, with no second email sent.
- All five old VPS application containers remained stopped throughout.

## SMTP transport and recovery

Home backend: host-owned Compose extra_hosts maps smtp-relay.gmail.com to10.77.0.1.
Platform SMTP port is2587, still STARTTLS; hostname is unchanged for certificate
verification. Explicit tenant settings using this same relay were adjusted only
from587 to2587. Other SMTP providers/credentials were not changed.

VPS `scanaki-smtp-proxy.service` runs the standard-library proxy at
`/opt/scanaki-smtp-gateway/proxy.py`, sourced from scripts/scanaki-smtp-proxy.py.
It binds only WireGuard10.77.0.1:2587, accepts home peer10.77.0.2, and connects
only to smtp-relay.gmail.com:587 using IPv4. It does not terminate TLS, inspect
mail content or log credentials. DynamicUser, restricted filesystem, bounded
connections/timeouts and64MiB memory limit apply. UFW permits only that peer.
This is gateway infrastructure, not a resumed VPS application workload.

Home `scanaki-smtp-egress-guard.service` installs the project-scoped
SCANAKI_SMTP_EGRESS chain in DOCKER-USER. Only backend outbound172.30.50.0/28
can use the new endpoint. A test from the frontend network was denied. The
guard is ordered after Docker and enabled with Docker. Do not flush shared rules.

Both units are enabled. Native home backups include the transport guard and CI
access policy; application SMTP settings/configuration are encrypted in backups.
Private recovery details remain outside Git. If the VPS public IPv4 changes,
Google's relay authorization must be reviewed. For future custom tenant SMTP
configuration using this mapped relay hostname, use the documented2587 transport;
do not assume465 or587 bypasses this routing. Authenticated alternative providers
using different hostnames are unaffected.

## Deployment boundary

`.github/workflows/deploy-scanaki-production.yml` retains its public name but no
longer contains VPS application deployment commands. Protected master application
changes trigger HOME deployment; explicit dispatch requires deploy_home=true.
SCANAKI_HOME_DEPLOY_ENABLED=1 enables the provisioned path. Environment
`scanaki-home` is limited to protected branches; workflow eligibility additionally
requires current master.

VPS `scanaki-ci-jump` can forward only to10.77.0.2:22, with no shell/session,
remote forward, PTY or agent forwarding. HOME `scanaki-ci` has no Docker group
and is restricted to `/usr/local/lib/scanaki-home-deploy/forced-command.sh`.
Sudo permits only the strict receiver protocol, not a shell or Docker command.
Private keys reside in protected C:\VPS-Recovery-Keys\scanaki-home-ci and encrypted
GitHub environment secrets; never in the project .env or repository.
HOME public authorized_keys is root-owned/readable0644 beneath root-owned0755
.ssh so sshd can read it as the account; only root can modify it.

Environment secrets: SCANAKI_HOME_JUMP_KEY, SCANAKI_HOME_CI_KEY,
SCANAKI_HOME_KNOWN_HOSTS. Variables: SCANAKI_HOME_JUMP_HOST=153.92.208.222,
SCANAKI_HOME_SSH_HOST=10.77.0.2, SCANAKI_HOME_SSH_PORT=22.
The previous SSH_PRIVATE_KEY_SCANAKI / SCANAKI_DEPLOY_HOST /
SCANAKI_DEPLOY_USER repository secrets were removed after acceptance. VPS
administrator access and stopped rollback data remain intact.

## Release safety

Installed root-owned receiver/executor and systemd template are under
`/usr/local/lib/scanaki-home-deploy` and `/etc/systemd/system` respectively.
State: `/var/lib/scanaki-home-deploy/SHA`. CI streams an immutable checksum-checked
archive containing exactly three revision-tagged images. Source/revision labels,
architecture, current runtime users and basic image compatibility are checked.
An invalid/truncated upload was rejected without queuing a deployment; arbitrary
commands and unrelated forwarding were denied in live tests.

The durable `scanaki-home-deploy@SHA.service` owns an exclusive deployment lock,
not the CI SSH observer. Superseded queued jobs skip before mutation. A fresh
native encrypted backup and private Compose snapshot precede writer shutdown
and migrations. DB/Redis/relay are not restarted; private mounts, volumes,
networks, commands, SMTP extra_hosts and environment are preserved. Images and
explicit runtime user preservation are the intended Compose changes.

Health, exact image IDs and recent logs gate success. Failed live mutation leaves
`recovery-required`, blocking later releases until operator inspection. Do not
blindly restart old images or downgrade the database. Same-revision submissions
are immutable: inspect server status after interruption instead of blind reruns.
Successful/superseded transfer archives are removed; failed archives and private
snapshots/digests remain. No global Docker/image pruning occurs.

Cancellation safety is provided by independent systemd ownership and tested
executor state/locking contracts. No deliberate mid-migration production kill
was performed. CI cancellation is not proof the server operation stopped.

## Assets and resource policy

Former cross-repository marketing fetch returned404 without suitable access.
Current served marketing sites and Android downloads were preserved in own-repo
prerelease asset scanaki-runtime-assets-20261027, not dropped or replaced by
placeholders. config/scanaki-runtime-assets.json pins its SHA256. Extraction
rejects unsafe paths/links and verifies all expected marketing indices and APKs.
Update that immutable snapshot/metadata when publishing changed static assets.

Verification runs on relevant PRs and reusable/manual eligible calls, avoiding
duplicate development-push builds. Production push and PR filters use actual
source/test/build paths; unrelated docs do not build images. The separate
pull_request_target docs workflow checks metadata only, never executes PR code,
and posts release-checks success only for a complete, unchanged docs-only change
set including rename origins. Code/mixed changes cannot use that shortcut.
Scoped cancel-in-progress and separate BuildKit verification/production caches
are configured; required checks were preserved. No runner or Docker was installed
or used on the administration PC. CI emitted action-runtime deprecation warnings
but passed; no unrelated toolchain upgrade was added to this change.

Future executor/protocol changes require reviewed operator installation; an
uploaded application release cannot overwrite this root control plane. Android
native builds, physical printing and live payment acceptance are separate from
this server-deployment acceptance.
