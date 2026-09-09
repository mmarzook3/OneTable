# Phase 4 rehearsal safeguards checkpoint

Date:2026-09-09. **Phase4 remains open; NO-GO for customer launch.**
Application release remains `d23e7e68e48cf1ae51064b117804d5a3f690f204` (2.2.3).

## Transaction safeguards

The draft coordinator now saves a durable noncredential recovery identity before
any seed commit, serializes seed/cleanup by nonce, and covers response/parsing
failures with cleanup. Raw seed without that identity is rejected. Checkpoints
are confined to project `tmp` and reject outside/traversal/alternate-stream paths.
Eight local negative cases passed; a junction-parent execution test was unavailable
and is not claimed passed.

Receipt windows are prepared with request guards before application receipt HTML
is written. Token-bearing paths are redacted. Deliberate write/external probes are
counted separately from unexpected requests; known blocked font resources are
not provider traffic. The local complete functional run passed at02:16:19Z,
including the two deliberate guard probes and cleanup of tenant14439/order5462.

The VPS run passed order creation/idempotency, cash700 settlement, kitchen/bar
routing and preparation/completion. It stopped with a TypeError during receipt
test initialization, before receipt or report acceptance. Tenant43 and its order
were removed, with the checked pulse keys absent and protected records unchanged.
No full VPS transaction pass is claimed. Production uses blocked Google Fonts
font-file requests rather than the local stylesheet requests; the test's expected
asset classification also needs reconciliation without permitting network egress.

## Isolated application recovery

The recovery worker reported successful current-release startup, health/docs/
OpenAPI, configuration manifest verification,11 restored upload hashes, and12
stored ciphertext decryptions in a crypto-only process using the recovered key.
Runtime provider/mail credentials were not activated. Authenticated read APIs
returned200; current and preserved frontend login forms rendered in an isolated
browser, with read API checks through both proxies. Owned cleanup passed.

This is functional evidence, not accepted recovery tooling yet: nginx response
buffering could spill restored API data onto its writable layer. Disable disk
buffering or move the proxy temporary storage to tmpfs, then rerun. No data exposure
is asserted from the positive checks. The prior frontend check does not establish
prior-backend rollback compatibility or production cutover.

## Rollback draft

The proposed future rollback baseline is the current verified release, not the
older backend with the known cash-release defect. The draft adds source/image/
configuration/schema guards and candidate-to-baseline replacement rehearsal.
It has not been executed on the VPS and remains default-no-op.

Review found two issues to correct before acceptance:

1. Receiver-side rsync deletion protection must cover every secret exclusion,
   including nested env/key files, not only the finite root paths.
2. Prevent or explicitly track and remove rehearsal-created anonymous volumes;
   container removal alone is not sufficient proof of cleanup.

No live rollback, database downgrade or production file deletion occurred.

## Fresh recurring backup

The scheduled02:20UTC backup was copied with transport checksum verification and
then separately confirmed through the Drive connector at02:22UTC:

- Database `scanaki_20260909_022002.sql.gz.enc`: `1uOP8GOflgofG3MrNj0kxt43VmCmsWHQE`.
- Database checksum: `1g-zHYhOonZn3Q6Lp5cf0GwyUFMP9C6jc`.
- Complete set `scanaki_recovery_20260909_022004_ffaf1e9413e4`: folder `1GqSC9M2B0AZnesSmtg4Ums1UpLIuC3u1`.
- Bundle: `1CVkdbqj-Mzh9RO1_vQUrdPuZAi-SK_v5`; checksum: `1kGahpc0xkmjJJgVCnjC3LJhNp1WRfw2f`.

Cloud confirmation is now recorded against the exact transfer in the nonsecret
local state. Connector evidence confirms names, sizes and presence; the transport
script supplied checksum verification. This newer bundle has not yet replaced
the older bundle in the full application rehearsal.

## Remaining work

Four corrections remain: VPS receipt-test initialization, isolated nginx disk
buffering, rollback secret-file protection, and anonymous-volume handling. The
affected new tooling remains uncommitted and unaccepted pending those corrections.
Only this evidence checkpoint is committed. Final physical acceptance remains
deferred until Phase4 engineering is complete; no GO is issued.
