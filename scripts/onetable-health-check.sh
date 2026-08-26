#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
BASE_URL="${ONETABLE_BASE_URL:-http://127.0.0.1:4202}"
COMPOSE=(docker compose --env-file config.env -f docker-compose.yml -f docker-compose.prod.yml)

curl --fail --silent --show-error --max-time 15 "$BASE_URL/" >/dev/null
curl --fail --silent --show-error --max-time 15 "$BASE_URL/api/health" >/dev/null
"${COMPOSE[@]}" exec -T back python -m app.seeds.check_onetable_payment_reconciliation
echo "Scanaki health check passed: $BASE_URL"
