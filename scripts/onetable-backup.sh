#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f config.env ]]; then
  echo "config.env is required" >&2
  exit 1
fi
BACKUP_PASSPHRASE="${ONETABLE_BACKUP_PASSPHRASE:-}"
if [[ ${#BACKUP_PASSPHRASE} -lt 20 ]]; then
  echo "ONETABLE_BACKUP_PASSPHRASE must contain at least 20 characters" >&2
  exit 1
fi
for tool in docker openssl gzip sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

BACKUP_DIR="${ONETABLE_BACKUP_DIR:-$ROOT_DIR/backups/onetable}"
RETAIN="${ONETABLE_BACKUP_RETAIN:-14}"
[[ "$RETAIN" =~ ^[1-9][0-9]*$ ]] || { echo "ONETABLE_BACKUP_RETAIN must be positive" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
OUTPUT="$BACKUP_DIR/onetable_${STAMP}.sql.gz.enc"
PARTIAL="$OUTPUT.partial"
trap 'rm -f "$PARTIAL"' EXIT

COMPOSE=(docker compose --env-file config.env -f docker-compose.yml -f docker-compose.prod.yml)
"${COMPOSE[@]}" exec -T db sh -c \
  'pg_dump --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip -9 \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
      -pass env:ONETABLE_BACKUP_PASSPHRASE -out "$PARTIAL"

[[ -s "$PARTIAL" ]] || { echo "Backup is empty" >&2; exit 1; }
mv "$PARTIAL" "$OUTPUT"
sha256sum "$OUTPUT" > "$OUTPUT.sha256"

mapfile -t OLD_BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'onetable_*.sql.gz.enc' -printf '%T@ %p\n' | sort -rn | tail -n "+$((RETAIN + 1))" | cut -d' ' -f2-)
for old in "${OLD_BACKUPS[@]}"; do
  rm -f -- "$old" "$old.sha256"
done

trap - EXIT
echo "$OUTPUT"
