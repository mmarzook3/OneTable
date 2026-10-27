# Scanaki home migration and cutover, 27 October 2026

## Status

**Public cutover completed with explicit owner approval.** The home database
is authoritative; https://scanaki.uk reaches it through the VPS gateway.
All five original VPS containers are stopped, restart disabled, with data intact.
Maintenance lasted approximately475 seconds (about8 minutes).

Final quiesced PostgreSQL, Redis, configuration and uploads were synchronized.
All80 tables/324 rows matched before switch. Public health/login/HTTPS and9/9
browser checks passed; test data removed. No recent matching application errors.
After new home writes, rollback MUST synchronize current data back first.

## Deployment

- Ubuntu VM100, `ubuntu-apps-01`, `192.168.55.247`; project `/opt/projects/scanaki`.
- Compose project `scanaki-home`, private root-owned `compose.json` (contains
  secrets; do not commit, display or index it).
- Containers `scanaki-home-{front,back,ws-bridge,db,redis}`. Existing runtime
  images `scanaki-restored-{front,back,ws-bridge,db,redis}:20261002` imported;
  image IDs matched the running VPS images. No application upgrade.
- Final volumes: `scanaki-home_database_cutover_20261027` and
  `scanaki-home_cache_cutover_20261027`. Fresh native PostgreSQL and Redis RDB
  snapshots restored; earlier rehearsal volumes remain separate.
- Frontend `127.0.0.1:28420`; database/cache/backend ports unpublished.
- Networks: web `172.30.48.0/28`; data `172.30.49.0/28` internal.
- Backend egress was blocked and tested during rehearsal. Cutover added the
  backend-only outbound network172.30.50.0/28; DB/Redis remain unpublished.
- Original `safe_start.py` still pauses reminder/social-publishing loops.
  Preserve that pre-existing operational choice unless separately approved.
- Original CPU/memory ceilings preserved; combined memory ceilings about
  2.25GiB. Restart policy `unless-stopped`, logs bounded at 10MiB x3.
- Guest root had 58GiB free after import. No virtual disk or Proxmox storage
  changes were made by this task. Other home projects were not restarted.

## Restricted relay and ingress

- Home `scanaki-relay.service`, enabled, user `scanaki-link`.
- Dedicated key stays under `/var/lib/scanaki-link/.ssh`; never copy its
  plaintext into project files or documentation.
- Transport: home WireGuard to VPS `10.77.0.1`, SSH host-key alias
  `153.92.208.222`, existing pinned identity, restart delay30 seconds.
- VPS user `scanaki-home-relay`; only remote listener
  `172.19.0.1:18220 -> home 127.0.0.1:28420` is permitted. Shell sessions,
  password auth, local forwarding, PTY, agent and X11 forwarding denied.
- VPS policy `/etc/ssh/sshd_config.d/57-scanaki-home-relay.conf`.
- UFW allows only current gateway address `172.19.0.5` to this bridge listener.
  Reconcile this scoped rule if the gateway container's address changes.
- Only the Scanaki upstream in `/opt/critical-services/nginx/conf.d/scanaki.uk.conf`
  changed to `http://172.19.0.1:18220`, after Nginx validation.
  DNS, public TLS, certificates/renewal and public80/443 stay on the VPS.
- Administrative SCP now prefers the documented LAN/WireGuard route because
  public SSH rate limiting can otherwise interrupt several parallel relays.
  No public SSH protection was relaxed.

## Measured acceptance

- All five home services healthy; private and original public health HTTP200.
- Every restored table's row count matched the exact transferred dump:
  **80 tables, 324 rows**. Configuration bytes matched the source archive.
  This snapshot had no uploaded user files; no upload-data recovery was invented.
- Preserved one restaurant, two users,128 products,38 ordering points,0 orders.
- Password login, Secure/HttpOnly cookies, anonymous denial, owner tables,
  products, tenant-products, public menus and existing QR endpoints passed.
- Authenticated staff and customer WebSocket connections passed.
- Browser checks through the private relay: **9/9 passed**, including paid-order
  restoration, reload/new tab, stranger isolation, stale offline tracking,
  Ready/reconnect and Delivered/reload. Synthetic fixture cleaned; no print jobs.
- **100 concurrent private readers,400 requests,0 failures; p95 2500ms,
  max2699ms.** This is menu/tracking capacity, not100 payments or a WAN SLA.
- Only Scanaki's five containers were restarted. Health and row-count
  persistence passed afterward. Shared host/VM reboot was NOT performed.
- Relay process terminated deliberately; automatic recovery observed after
  the35-second window. Shell and unapproved-listener denial tests passed.
- No real order, payment, email or physical print was submitted.

## Backups

- Fresh source native backup completed; encrypted files and runtime-image
  archive SHA256-verified under
  `C:\VPS-Backups\scanaki\scanaki-20261027T121948Z` (image archive in parent).
- Home `/opt/projects/scanaki/backup.py`, `scanaki-home-backup.service/timer`:
  daily03:15 Europe/London plus up to120 seconds jitter; bounded database
  readiness probe, lock and timeout. Minimum2GiB free-space guard.
- Encrypted native database/configuration backups under
  `/home/marzook/scanaki-encrypted-backups`; no private decryption key on home.
- First verified home set `scanaki-home-20261027T131807Z` copied to
  `C:\VPS-Backups\scanaki-home` and SHA256 checked. Existing age recovery key
  remains at its protected external recovery-key location.
- Windows task `Scanaki Home Encrypted Backup Pull`, daily05:55, registered.
  Its reader prefers pinned LAN SSH when reachable, otherwise the management
  relay. Manual execution passed. PC must be on and user logged in; this is
  off-host storage, not independently verified cloud/offsite replication.
- Home sets are not automatically deleted. Add verified off-host retention
  before significant growth; the space guard fails closed rather than filling
  the filesystem. VPS backup timer and old Windows Scanaki backup pull task
  are disabled; home backup timer and new Windows pull task are active.
- VM100 daily backups on ssd2 are additional crash-consistent protection, not
  a substitute for native dumps or an independent offsite copy.

## Required cutover and rollback

1. Obtain a maintenance window. Back up the current Scanaki-only ingress file.
2. Quiesce Scanaki writes and existing WebSockets; stop only source application
   writers. Keep the source database available for the final native dump.
3. Capture a final consistent database/uploads/private-configuration set and
   appropriate Redis snapshot. Preserve encryption keys. Transfer with hashes.
4. Stop the private home app; restore final data into fresh project-specific
   storage. Compare counts/files. Do not use this older rehearsal snapshot.
5. Restore only the backend outbound connectivity needed for production;
   keep previously paused jobs paused. Start and test home dependencies.
6. Switch ONLY Scanaki's VPS upstream to `http://172.19.0.1:18220`; run
   `docker exec critical-https-proxy nginx -t` before reload. No DNS change.
7. Verify public HTTPS, authentication, QR/order flows and WebSockets. Retain
   old VPS containers/data stopped and intact; prevent duplicate writers.
   Switch the source-specific backup schedules deliberately.
8. Before home accepts new writes, rollback can restore the old route and
   writers. **After new writes, quiesce and synchronize data back before any
   rollback; never blindly start stale VPS data.**

Cutover sequence completed. Final source checkpoint:
`/opt/scanaki/app/tmp/cutover-20261027`; home checkpoint:
`/opt/projects/scanaki/cutover-20261027`. Final source encrypted archive and
checksum verified under `C:\VPS-Backups\scanaki-home\cutover-20261027`.
Post-cutover home backup `scanaki-home-20261027T135501Z` copied/hash-verified
off-host. No live-payment, hardware, AC-loss or new full-host reboot claim.

SMTP limitation: TLS/EHLO succeeded, but support@scanaki.uk sender probes
returned550 from BOTH old VPS and home. No email sent; delivery/provider
authorization remains unverified. The new outbound source IP must also be
considered when repairing an IP-allowlisted SMTP relay.

Legacy GitHub `Deploy Scanaki production` workflow was disabled to prevent
resurrecting stale VPS writers. Verification workflows remain enabled. Future
automated upgrades require a home-aware deployment workflow. Documentation-only
push is withheld because current workflows lack path eligibility gates and
would trigger unrelated builds. No application image upgrade was performed.

## Corrective evidence

- Database restore: one correction. Initial `pg_isready` accepted the temporary
  initialization socket before the database existed; replaced by a successful
  TCP SQL query to the actual database. Empty database restored successfully.
- Public-key handoff: one correction. The sudo helper inherits stdout rather
  than returning a PowerShell value; transferred only the public-key file.
- Public SSH timeouts: two routing corrections (admin transfer and backup
  reader), using already-authorized private/LAN routes, not relaxed limits.
- Backup reader: one permission correction. Explicit750 on encrypted-set
  directories after restrictive umask; plaintext configuration remains private.
- SSH denial assertion: one test correction for the observed authenticated
  `channel 0: open failed` response. Server restrictions were not changed.
- Final-sync preflight: one correction for null Docker IPAM Config; caught
  before home database mutation, corrected and passed.
- SMTP probe: stage-specific checks with explicit EHLO established TLS success
  and550 sender rejection on both hosts; no blind message-send retries.

Detailed private operational reports are under
`/opt/projects/scanaki/migration/`; browser report is
`tmp/scanaki-home-browser-20261027-results.json`. Do not commit raw dumps,
private manifests, configuration or credentials.
