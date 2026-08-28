#!/usr/bin/env bash
set -uo pipefail

ENV_FILE="${SCANAKI_OPS_ENV_FILE:-/etc/scanaki/ops.env}"
[[ -r "$ENV_FILE" ]] || { echo "Scanaki ops environment is missing: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ACTION="${1:-}"
APP_DIR="${SCANAKI_APP_DIR:-/opt/scanaki/app}"
LOG_FILE="${SCANAKI_OPS_LOG_FILE:-/var/log/scanaki-ops.log}"
LOCK_FILE="/run/lock/scanaki-ops-${ACTION:-unknown}.lock"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

run_action() {
  case "$ACTION" in
    backup)
      "$APP_DIR/scripts/scanaki-backup.sh"
      ;;
    health)
      "$APP_DIR/scripts/scanaki-health-check.sh"
      ;;
    restore-latest)
      latest="$(find "${SCANAKI_BACKUP_DIR:-$APP_DIR/backups/scanaki}" -maxdepth 1 -type f -name 'scanaki_*.sql.gz.enc' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
      [[ -n "$latest" ]] || { echo "No Scanaki backup found" >&2; return 1; }
      "$APP_DIR/scripts/scanaki-restore-check.sh" "$latest"
      ;;
    *)
      echo "Usage: $0 {backup|health|restore-latest}" >&2
      return 2
      ;;
  esac
}

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT="$(run_action 2>&1)"
RC=$?
printf '%s [%s] action=%s rc=%s %s\n' "$STAMP" "$$" "$ACTION" "$RC" "$OUTPUT" >>"$LOG_FILE"
logger -t scanaki-ops "action=$ACTION rc=$RC $OUTPUT"
if [[ "$RC" -ne 0 ]]; then
  MESSAGE="Scanaki ${ACTION} failed on $(hostname): ${OUTPUT:0:1200}"
  if [[ -n "${SCANAKI_ALERT_EMAIL:-}" ]]; then
    COMPOSE_FILE="${SCANAKI_COMPOSE_FILE:-docker-compose.prod.yml}"
    if [[ "$COMPOSE_FILE" == "docker-compose.scanaki.yml" ]]; then
      COMPOSE=(docker compose --env-file "$APP_DIR/config.env" -f "$APP_DIR/$COMPOSE_FILE")
    elif [[ "$COMPOSE_FILE" == "docker-compose.yml" ]]; then
      COMPOSE=(docker compose --env-file "$APP_DIR/config.env" -f "$APP_DIR/docker-compose.yml")
    else
      COMPOSE=(docker compose --env-file "$APP_DIR/config.env" -f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/$COMPOSE_FILE")
    fi
    if ! "${COMPOSE[@]}" exec -T back python -m app.seeds.send_platform_alert \
      --recipient "$SCANAKI_ALERT_EMAIL" \
      --subject "Scanaki ${ACTION} failure" \
      --message "$MESSAGE" >>"$LOG_FILE" 2>&1; then
      logger -t scanaki-ops "email alert delivery failed action=$ACTION"
    fi
  fi
  if [[ -n "${SCANAKI_ALERT_WEBHOOK_URL:-}" ]]; then
    curl --silent --show-error --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      --data "{\"text\":$(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
      "$SCANAKI_ALERT_WEBHOOK_URL" >/dev/null || true
  fi
fi
printf '%s\n' "$OUTPUT"
exit "$RC"
