#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${SCANAKI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT_DIR"
BACKUP_FILE="${1:-}"
[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]] || {
  echo "Usage: SCANAKI_BACKUP_PASSPHRASE=... $0 <backup.sql.gz.enc>" >&2
  exit 1
}
PASSPHRASE="${SCANAKI_BACKUP_PASSPHRASE:-}"
[[ ${#PASSPHRASE} -ge 20 ]] || {
  echo "SCANAKI_BACKUP_PASSPHRASE must contain at least 20 characters" >&2
  exit 1
}
for tool in docker openssl gzip sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done
if [[ -f "$BACKUP_FILE.sha256" ]]; then
  (cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256" >/dev/null)
fi

if [[ -n "${SCANAKI_COMPOSE_FILE:-}" ]]; then
  COMPOSE_FILE="$SCANAKI_COMPOSE_FILE"
elif [[ -f docker-compose.scanaki.yml ]]; then
  COMPOSE_FILE="docker-compose.scanaki.yml"
else
  COMPOSE_FILE="docker-compose.prod.yml"
fi
if [[ "$COMPOSE_FILE" == "docker-compose.scanaki.yml" ]]; then
  COMPOSE=(docker compose --env-file config.env -f "$COMPOSE_FILE")
elif [[ "$COMPOSE_FILE" == "docker-compose.yml" ]]; then
  COMPOSE=(docker compose --env-file config.env -f docker-compose.yml)
else
  COMPOSE=(docker compose --env-file config.env -f docker-compose.yml -f "$COMPOSE_FILE")
fi

CHECK_DB="scanaki_restore_check_$(date -u +%Y%m%d%H%M%S)"
[[ "$CHECK_DB" =~ ^[A-Za-z][A-Za-z0-9_]{0,62}$ ]] || exit 1
cleanup() {
  "${COMPOSE[@]}" exec -T db sh -c \
    "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$CHECK_DB' AND pid <> pg_backend_pid();\" -c \"DROP DATABASE IF EXISTS $CHECK_DB;\"" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c \"CREATE DATABASE $CHECK_DB;\"" \
  >/dev/null

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:SCANAKI_BACKUP_PASSPHRASE -in "$BACKUP_FILE" \
  | gzip -dc \
  | "${COMPOSE[@]}" exec -T db sh -c \
      "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -v ON_ERROR_STOP=1" \
      >/dev/null

TENANT_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM tenant;\"")"
REAL_TENANT_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM tenant WHERE is_demo = false;\"")"
TABLE_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public';\"")"
LOCATION_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM tenant_location;\"")"
ORDERING_POINT_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM \\\"table\\\";\"")"
ORPHAN_POINT_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM \\\"table\\\" p LEFT JOIN tenant_location l ON l.id=p.location_id WHERE l.id IS NULL OR l.tenant_id<>p.tenant_id;\"")"
YEW_LOCATION_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM tenant_location l JOIN tenant t ON t.id=l.tenant_id WHERE t.name='The Yew Trees Pub';\"")"

[[ "$TENANT_COUNT" -ge 1 ]] || { echo "Restore check failed: no tenant rows" >&2; exit 1; }
[[ "$REAL_TENANT_COUNT" -ge 1 ]] || { echo "Restore check failed: no non-demo tenant" >&2; exit 1; }
[[ "$TABLE_COUNT" -ge 20 ]] || { echo "Restore check failed: schema incomplete" >&2; exit 1; }
[[ "$LOCATION_COUNT" -ge "$TENANT_COUNT" ]] || { echo "Restore check failed: tenant locations missing" >&2; exit 1; }
[[ "$ORPHAN_POINT_COUNT" -eq 0 ]] || { echo "Restore check failed: orphan ordering points" >&2; exit 1; }
if [[ "$YEW_LOCATION_COUNT" -gt 0 && "$YEW_LOCATION_COUNT" -ne 4 ]]; then
  echo "Restore check failed: Yew Trees must have four locations" >&2
  exit 1
fi
echo "Restore check passed: tenants=$TENANT_COUNT locations=$LOCATION_COUNT ordering_points=$ORDERING_POINT_COUNT real_tenants=$REAL_TENANT_COUNT schema_tables=$TABLE_COUNT"
