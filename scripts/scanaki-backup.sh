#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${SCANAKI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT_DIR"
[[ -f config.env ]] || { echo "config.env is required" >&2; exit 1; }

PASSPHRASE="${SCANAKI_BACKUP_PASSPHRASE:-}"
[[ ${#PASSPHRASE} -ge 20 ]] || {
  echo "SCANAKI_BACKUP_PASSPHRASE must contain at least 20 characters" >&2
  exit 1
}
for tool in docker openssl gzip sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

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

BACKUP_DIR="${SCANAKI_BACKUP_DIR:-$ROOT_DIR/backups/scanaki}"
RETAIN="${SCANAKI_BACKUP_RETAIN:-14}"
[[ "$RETAIN" =~ ^[1-9][0-9]*$ ]] || { echo "SCANAKI_BACKUP_RETAIN must be positive" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
OUTPUT="$BACKUP_DIR/scanaki_${STAMP}.sql.gz.enc"
PARTIAL="$OUTPUT.partial"
trap 'rm -f "$PARTIAL"' EXIT

"${COMPOSE[@]}" exec -T db sh -c \
  'pg_dump --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip -9 \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
      -pass env:SCANAKI_BACKUP_PASSPHRASE -out "$PARTIAL"

[[ -s "$PARTIAL" ]] || { echo "Backup is empty" >&2; exit 1; }
mv "$PARTIAL" "$OUTPUT"
chmod 600 "$OUTPUT"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$OUTPUT")" >"$(basename "$OUTPUT").sha256")
chmod 600 "$OUTPUT.sha256"

mapfile -t OLD_BACKUPS < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'scanaki_*.sql.gz.enc' -printf '%T@ %p\n' \
    | sort -rn | tail -n "+$((RETAIN + 1))" | cut -d' ' -f2-
)
for old in "${OLD_BACKUPS[@]}"; do
  rm -f -- "$old" "$old.sha256"
done

trap - EXIT
echo "$OUTPUT"
