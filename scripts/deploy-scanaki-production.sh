#!/usr/bin/env bash
# Deploy only the isolated Scanaki Compose project on the production VPS.

set -Eeuo pipefail

DEPLOY_LOCK="/run/lock/scanaki-production-deploy.lock"
install -d "$(dirname "$DEPLOY_LOCK")"
exec 9>"$DEPLOY_LOCK"
if ! flock -n 9; then
  echo "Another Scanaki production deployment is already running; refusing a concurrent build." >&2
  exit 75
fi

AVAILABLE_KB="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
MIN_BUILD_KB="${SCANAKI_MIN_BUILD_MEMORY_KB:-2097152}"
if [[ ! "$AVAILABLE_KB" =~ ^[0-9]+$ || "$AVAILABLE_KB" -lt "$MIN_BUILD_KB" ]]; then
  echo "Insufficient available memory for a safe Scanaki build: ${AVAILABLE_KB:-unknown}kB" >&2
  exit 1
fi

ROOT_DIR="${SCANAKI_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT_DIR"

for required in config.env deployment-secrets.env docker-compose.scanaki.yml nginx.scanaki.conf; do
  [[ -s "$required" ]] || { echo "Required production file is missing: $required" >&2; exit 1; }
done
[[ -r /etc/scanaki/ops.env ]] || { echo "/etc/scanaki/ops.env is required" >&2; exit 1; }

set -a
# Server-owned files; never copied from GitHub Actions.
# shellcheck disable=SC1091
source deployment-secrets.env
# shellcheck disable=SC1091
source /etc/scanaki/ops.env
set +a

COMPOSE=(docker compose --env-file config.env -f docker-compose.scanaki.yml)

# GitHub concurrency protects Actions runs, while this host lock also protects
# against a simultaneous manual deployment on the VPS. Never allow two image
# builds or migration sequences to compete for this host.
exec 9>/run/lock/scanaki-production-deploy.lock
if ! flock -w 1800 9; then
  echo "Another Scanaki deployment still owns the server lock after 30 minutes." >&2
  exit 1
fi

show_failure_context() {
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "Scanaki deployment failed; the database and previous application containers were not removed." >&2
    "${COMPOSE[@]}" ps >&2 || true
    "${COMPOSE[@]}" logs --tail=120 back front ws-bridge >&2 || true
  fi
  exit "$rc"
}
trap show_failure_context EXIT

"${COMPOSE[@]}" config --quiet
install -d -o 1000 -g 1000 data/uploads

if [[ -n "$("${COMPOSE[@]}" ps --status running -q db 2>/dev/null)" ]]; then
  echo "Creating encrypted pre-deploy database backup..."
  SCANAKI_APP_DIR="$ROOT_DIR" SCANAKI_COMPOSE_FILE=docker-compose.scanaki.yml \
    scripts/scanaki-backup.sh
else
  echo "Database is not running; skipping backup for first deployment."
fi

COMMIT_HASH="$(tr -d '\r\n' < release-commit.txt 2>/dev/null || true)"
[[ "$COMMIT_HASH" =~ ^[0-9a-f]{7,40}$ ]] || { echo "release-commit.txt is invalid" >&2; exit 1; }
export COMMIT_HASH

echo "Building Scanaki images for ${COMMIT_HASH:0:9} while the current stack remains online..."
# Build sequentially to cap peak CPU/RAM usage on the multi-project VPS.
"${COMPOSE[@]}" build back
"${COMPOSE[@]}" build ws-bridge
"${COMPOSE[@]}" build front

echo "Ensuring Scanaki database and Redis are healthy..."
"${COMPOSE[@]}" up -d db redis

echo "Applying database migrations before application replacement..."
"${COMPOSE[@]}" run --rm back python -m app.migrate
"${COMPOSE[@]}" run --rm back python -m app.migrate --sync-idempotent

echo "Replacing only containers in the scanaki_prod Compose project..."
"${COMPOSE[@]}" up -d --remove-orphans

echo "Applying idempotent Scanaki production seeds..."
"${COMPOSE[@]}" exec -T back python -m app.seeds.ensure_landing_demo
"${COMPOSE[@]}" exec -T back python -m app.seeds.seed_yue_tree_pilot

echo "Waiting for Scanaki public health..."
healthy=""
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 8 https://scanaki.uk/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
[[ -n "$healthy" ]] || { echo "Scanaki public health check timed out" >&2; exit 1; }

SCANAKI_APP_DIR="$ROOT_DIR" SCANAKI_COMPOSE_FILE=docker-compose.scanaki.yml \
  SCANAKI_BASE_URL=https://scanaki.uk scripts/scanaki-health-check.sh

echo "Checking recent Scanaki container logs..."
if "${COMPOSE[@]}" logs --since 5m --tail=160 back front ws-bridge 2>&1 \
  | grep -Eiq 'application bundle generation failed|traceback|fatal|uncaught exception'; then
  echo "Recent Scanaki logs contain a deployment error." >&2
  "${COMPOSE[@]}" logs --since 5m --tail=160 back front ws-bridge >&2
  exit 1
fi

trap - EXIT
echo "Scanaki production deployment completed: ${COMMIT_HASH:0:9}"
