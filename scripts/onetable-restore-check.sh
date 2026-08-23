#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "Usage: ONETABLE_BACKUP_PASSPHRASE=... $0 <backup.sql.gz.enc>" >&2
  exit 1
fi
BACKUP_PASSPHRASE="${ONETABLE_BACKUP_PASSPHRASE:-}"
if [[ ${#BACKUP_PASSPHRASE} -lt 20 ]]; then
  echo "ONETABLE_BACKUP_PASSPHRASE must contain at least 20 characters" >&2
  exit 1
fi
for tool in docker openssl gzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

CHECK_DB="onetable_restore_check_$(date -u +%Y%m%d%H%M%S)"
[[ "$CHECK_DB" =~ ^[A-Za-z][A-Za-z0-9_]{0,62}$ ]] || exit 1
COMPOSE=(docker compose --env-file config.env -f docker-compose.yml -f docker-compose.prod.yml)

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
  -pass env:ONETABLE_BACKUP_PASSPHRASE -in "$BACKUP_FILE" \
  | gzip -dc \
  | "${COMPOSE[@]}" exec -T db sh -c \
      "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -v ON_ERROR_STOP=1" \
      >/dev/null

TENANT_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM tenant WHERE name = 'The Yue Tree Pub';\"")"
TABLE_COUNT="$("${COMPOSE[@]}" exec -T db sh -c \
  "psql -U \"\$POSTGRES_USER\" -d '$CHECK_DB' -Atqc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public';\"")"

[[ "$TENANT_COUNT" -ge 1 ]] || { echo "Restore check failed: Yue Tree tenant missing" >&2; exit 1; }
[[ "$TABLE_COUNT" -ge 20 ]] || { echo "Restore check failed: schema incomplete" >&2; exit 1; }
echo "Restore check passed in isolated database: tenant=$TENANT_COUNT schema_tables=$TABLE_COUNT"
