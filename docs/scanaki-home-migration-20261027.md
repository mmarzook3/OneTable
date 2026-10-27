# Scanaki home migration: private acceptance, 27 October 2026

## Status

Private preparation passed. **Public cutover is NOT performed or approved.**
https://scanaki.uk still routes to the original VPS containers. The home copy
is a rehearsal snapshot, not the authoritative writer. Refresh it from a final
quiesced source snapshot before cutover; do not overwrite newer source data.

## Deployment

- Ubuntu VM100, `ubuntu-apps-01`, `192.168.55.247`; project `/opt/projects/scanaki`.
- Compose project `scanaki-home`, private root-owned `compose.json` (contains
  secrets; do not commit, display or index it).
- Containers `scanaki-home-{front,back,ws-bridge,db,redis}`. Existing runtime
  images `scanaki-restored-{front,back,ws-bridge,db,redis}:20261002` imported;
  image IDs matched the running VPS images. No application upgrade.
- PostgreSQL18 and Redis use dedicated `scanaki-home_database` and
  `scanaki-home_cache` volumes. PostgreSQL restored from a fresh custom dump;
  the private Redis is an empty rehearsal cache, NOT a final Redis migration.
- Frontend `127.0.0.1:28420`; database/cache/backend ports unpublished.
- Networks: web `172.30.48.0/28`; data `172.30.49.0/28` internal.
- Backend belongs only to the internal network. Outbound connection denial was
  tested. Email/payment/provider traffic cannot leave this rehearsal backend.
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
- Existing `/opt/critical-services/nginx/conf.d/scanaki.uk.conf` is unchanged.
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
  the filesystem. Existing VPS backups/tasks remain unchanged before cutover.
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

Pending: approval/window, final sync/Redis, public cutover and public post-cutover
tests. No claim of live-payment, hardware, AC-loss or new full-host reboot tests.
Legacy GitHub deployment still targets the VPS layout; do not dispatch it for
the home deployment. Documentation-only push is withheld because current
workflows lack the required path eligibility gates and would trigger builds.

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

Detailed private operational reports are under
`/opt/projects/scanaki/migration/`; browser report is
`tmp/scanaki-home-browser-20261027-results.json`. Do not commit raw dumps,
private manifests, configuration or credentials.
