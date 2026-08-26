#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${SCANAKI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT_DIR"
[[ -f config.env ]] || { echo "config.env is required" >&2; exit 1; }

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

BASE_URL="${SCANAKI_BASE_URL:-$(sed -n 's/^PUBLIC_APP_BASE_URL=//p' config.env | tail -1)}"
BASE_URL="${BASE_URL:-https://scanaki.uk}"
BASE_URL="${BASE_URL%/}"

curl --fail --silent --show-error --max-time 15 "$BASE_URL/" >/dev/null
curl --fail --silent --show-error --max-time 15 "$BASE_URL/api/health" >/dev/null
for service in $("${COMPOSE[@]}" config --services); do
  [[ -n "$("${COMPOSE[@]}" ps --status running -q "$service")" ]] || {
    echo "Container service is not running: $service" >&2
    exit 1
  }
done
"${COMPOSE[@]}" exec -T back python -m app.seeds.check_onetable_payment_reconciliation

BACKUP_DIR="${SCANAKI_BACKUP_DIR:-$ROOT_DIR/backups/scanaki}"
LATEST_BACKUP="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'scanaki_*.sql.gz.enc' -mmin -1800 -print -quit 2>/dev/null || true)"
[[ -n "$LATEST_BACKUP" ]] || { echo "No encrypted Scanaki backup newer than 30 hours" >&2; exit 1; }

if [[ "$BASE_URL" == https://* ]]; then
  HOST="${BASE_URL#*://}"
  HOST="${HOST%%/*}"
  TLS_END="$(echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2-)"
  openssl x509 -checkend 1209600 -noout < <(
    echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null
  ) >/dev/null || { echo "TLS certificate expires within 14 days: $TLS_END" >&2; exit 1; }
fi

DISK_USED="$(df -P "$ROOT_DIR" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
[[ "$DISK_USED" =~ ^[0-9]+$ && "$DISK_USED" -lt 90 ]] || {
  echo "Disk usage is at or above 90%: ${DISK_USED}%" >&2
  exit 1
}
echo "Scanaki health check passed: url=$BASE_URL disk=${DISK_USED}% backup=$(basename "$LATEST_BACKUP")"
