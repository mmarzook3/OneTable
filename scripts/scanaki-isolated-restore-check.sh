#!/usr/bin/env bash
# Usage: SCANAKI_BACKUP_PASSPHRASE=... bash "$0" --execute <encrypted-backup> <deployed-sha> <expected-backend-image>
# Database/model-column readback only: not application startup, uploads or rollback proof.
set -euo pipefail
set +x
umask 077

fail() { printf '%s\n' 'FAIL isolated restore prerequisites or verification' >&2; exit 1; }
[[ $# == 4 && $1 == --execute && $3 =~ ^[a-f0-9]{40}$ && $4 =~ ^sha256:[a-f0-9]{64}$ ]] || fail
passphrase="${SCANAKI_BACKUP_PASSPHRASE:-}"
[[ ${#passphrase} -ge 20 ]] || fail
root="$(readlink -f "${SCANAKI_APP_DIR:-/opt/scanaki/app}")"
backup="$(readlink -f "$2")"
[[ -d "$root" && -f "$backup" && ! -L "$2" && ! -L "$backup.sha256" ]] || fail
case "$backup" in
  "$root"/backups/scanaki/*|"$root"/tmp/phase4-offsite/*) ;;
  *) fail ;;
esac
name="$(basename "$backup")"
[[ $name =~ ^scanaki_[0-9]{8}_[0-9]{6}\.sql\.gz\.enc$ ]] || fail
[[ -f "$backup.sha256" ]] || fail

python3 - "$backup" <<'PY'
import hashlib, pathlib, re, sys
try:
    p = pathlib.Path(sys.argv[1])
    match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *]' + re.escape(p.name),
                         pathlib.Path(str(p) + '.sha256').read_text().strip())
    if match is None:
        raise ValueError()
    h = hashlib.sha256()
    with p.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    if h.hexdigest() != match[1].lower():
        raise ValueError()
except Exception:
    print('FAIL encrypted backup checksum', file=sys.stderr)
    sys.exit(1)
PY

# Share the deployment lock while capturing identities. The explicit approved
# backend digest also guards against a release marker copied ahead of deployment.
deploy_lock=/run/lock/scanaki-production-deploy.lock
[[ -f "$deploy_lock" && ! -L "$deploy_lock" ]] || fail
exec 9<"$deploy_lock"
flock -s -n 9 || fail
[[ "$(tr -d '\r\n' < "$root/release-commit.txt")" == "$3" ]] || fail
backend_image="$(docker inspect scanaki-back --format '{{.Image}}')"
postgres_image="$(docker inspect scanaki-db --format '{{.Image}}')"
[[ $backend_image =~ ^sha256:[a-f0-9]{64}$ && $postgres_image =~ ^sha256:[a-f0-9]{64}$ ]] || fail
[[ $backend_image == "$4" ]] || fail
flock -u 9
exec 9<&-
nonce="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
db="scanaki-phase4-db-$nonce"
probe="scanaki-phase4-probe-$nonce"
cleanup() {
  rc=$?
  trap - EXIT
  for container in "$probe" "$db"; do
    if ! present="$(docker container ls -aq --filter "name=^/${container}$" 2>/dev/null)"; then
      rc=1
      continue
    fi
    [[ -n "$present" ]] || continue
    if ! label="$(docker inspect "$container" --format '{{index .Config.Labels "scanaki.rehearsal"}}' 2>/dev/null)"; then
      rc=1
      continue
    fi
    if [[ $label != "$nonce" ]]; then rc=1; continue; fi
    docker rm -f -v "$container" >/dev/null 2>&1 || rc=1
    if ! present="$(docker container ls -aq --filter "name=^/${container}$" 2>/dev/null)"; then
      rc=1
    elif [[ -n "$present" ]]; then
      rc=1
    fi
  done
  if [[ $rc == 0 ]]; then
    printf '%s\n' 'PASS isolated database/model-column recovery; owned containers removed; no live restore or cutover'
  else
    printf '%s\n' 'FAIL isolated database/model-column recovery; owned cleanup attempted' >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

docker run -d --rm --name "$db" --label "scanaki.rehearsal=$nonce" \
  --network none --log-driver none --tmpfs /tmp:rw,size=512m \
  -e PGDATA=/tmp/pgdata -e POSTGRES_USER=pos \
  -e POSTGRES_PASSWORD=synthetic-isolated-restore \
  -e POSTGRES_DB=scanaki_phase4_restore "$postgres_image" >/dev/null
ready=0
for attempt in $(seq 1 40); do
  if docker exec "$db" pg_isready -h 127.0.0.1 -U pos -d scanaki_phase4_restore >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
[[ $ready == 1 ]] || fail

# All decrypted SQL stays in pipes and the isolated tmpfs database. Never print SQL errors.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:SCANAKI_BACKUP_PASSPHRASE -in "$backup" 2>/dev/null \
  | gzip -dc 2>/dev/null \
  | docker exec -i "$db" psql -X -U pos -d scanaki_phase4_restore -v ON_ERROR_STOP=1 >/dev/null 2>&1

docker run --rm -i --name "$probe" --label "scanaki.rehearsal=$nonce" \
  --network "container:$db" --log-driver none \
  -e DB_HOST=127.0.0.1 -e DB_PORT=5432 -e DB_USER=pos \
  -e DB_PASSWORD=synthetic-isolated-restore -e DB_NAME=scanaki_phase4_restore \
  -e SECRET_KEY=synthetic-isolated-signing-key-not-production \
  -e REFRESH_SECRET_KEY=synthetic-isolated-refresh-key-not-production \
  -e STRIPE_SECRET_KEY= -e SMTP_HOST= -e REDIS_URL= \
  --entrypoint python "$backend_image" - <<'PY'
import contextlib, io, json, logging, sys
logging.disable(logging.CRITICAL)
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from app import main  # Register current model columns; do not enter application lifespan.
        from app.db import engine
        from sqlalchemy import select, text
        from sqlmodel import Session, SQLModel
        with Session(engine) as session:
            tables = list(SQLModel.metadata.tables.values())
            for table in tables:
                session.execute(select(table).limit(1)).first()
            schema = session.execute(text("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).scalar_one()
            tenants = session.execute(text('SELECT count(*) FROM tenant')).scalar_one()
            real = session.execute(text('SELECT count(*) FROM tenant WHERE is_demo=false')).scalar_one()
            orphans = session.execute(text('SELECT count(*) FROM "table" p LEFT JOIN tenant_location l ON l.id=p.location_id WHERE l.id IS NULL OR l.tenant_id<>p.tenant_id')).scalar_one()
            if schema < 20 or tenants < 1 or real < 1 or orphans != 0:
                raise ValueError()
    print(json.dumps({'result': 'PASS', 'schema_tables': schema,
                      'current_model_tables_read': len(tables),
                      'orphan_ordering_points': orphans,
                      'scope': 'database restore and current model-column readback only'}))
except Exception:
    print('FAIL current model-column readback or restored data invariants', file=sys.stderr)
    sys.exit(1)
PY
