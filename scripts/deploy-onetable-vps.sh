#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[[ -f config.env ]] || { echo "Create config.env first" >&2; exit 1; }

read_config() { sed -n "s/^$1=//p" config.env | tail -1; }
PUBLIC_URL="$(read_config PUBLIC_APP_BASE_URL)"
CORS="$(read_config CORS_ORIGINS)"
SECRET="$(read_config SECRET_KEY)"
REFRESH="$(read_config REFRESH_SECRET_KEY)"
[[ "$PUBLIC_URL" == https://* ]] || { echo "PUBLIC_APP_BASE_URL must use HTTPS" >&2; exit 1; }
[[ "$CORS" != *localhost* && "$CORS" != *127.0.0.1* ]] || { echo "CORS_ORIGINS still contains a local address" >&2; exit 1; }
[[ ${#SECRET} -ge 32 && "$SECRET" != *CHANGE_THIS* ]] || { echo "Set a strong SECRET_KEY" >&2; exit 1; }
[[ ${#REFRESH} -ge 32 && "$REFRESH" != *CHANGE_THIS* ]] || { echo "Set a strong REFRESH_SECRET_KEY" >&2; exit 1; }
compgen -G 'certbot/haproxy-certs/*.pem' >/dev/null || { echo "Install the production HAProxy PEM certificate first" >&2; exit 1; }

COMPOSE=(docker compose --env-file config.env -f docker-compose.yml -f docker-compose.prod.yml)
if "${COMPOSE[@]}" ps -q db | grep -q .; then
  "$ROOT_DIR/scripts/onetable-backup.sh" >/dev/null
fi

export COMMIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || true)"
"${COMPOSE[@]}" build back front ws-bridge
"${COMPOSE[@]}" up -d db redis
"${COMPOSE[@]}" run --rm back python -m app.migrate
"${COMPOSE[@]}" run --rm back python -m app.migrate --sync-idempotent
"${COMPOSE[@]}" up -d --remove-orphans
"${COMPOSE[@]}" exec -T back python -m app.seeds.ensure_landing_demo
"${COMPOSE[@]}" exec -T back python -m app.seeds.seed_yue_tree_pilot

for attempt in {1..30}; do
  if curl --fail --silent --max-time 5 "$PUBLIC_URL/api/health" >/dev/null; then
    "$ROOT_DIR/scripts/onetable-health-check.sh"
    echo "Scanaki deployed at $PUBLIC_URL"
    exit 0
  fi
  sleep 2
done
"${COMPOSE[@]}" logs --tail=100 back front haproxy
echo "Deployment did not become healthy" >&2
exit 1
