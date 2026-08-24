#!/bin/sh
set -e

# Get API and WS URLs from environment variables, with defaults
API_URL="${API_URL:-http://localhost:8020}"
WS_URL="${WS_URL:-ws://localhost:8021}"
STRIPE_PUBLISHABLE_KEY="${STRIPE_PUBLISHABLE_KEY:-}"
GOOGLE_ANALYTICS_MEASUREMENT_ID="${GOOGLE_ANALYTICS_MEASUREMENT_ID:-}"

# Replace placeholders in index.html with actual values
# Use # as delimiter to avoid conflicts with URLs and || operator
# Escape special characters for sed (slashes, ampersands, etc.)
API_URL_ESCAPED=$(echo "$API_URL" | sed 's/[\/&]/\\&/g')
WS_URL_ESCAPED=$(echo "$WS_URL" | sed 's/[\/&]/\\&/g')
STRIPE_KEY_ESCAPED=$(echo "$STRIPE_PUBLISHABLE_KEY" | sed 's/[\/&]/\\&/g')

# Replace the default values in the JavaScript code
# Only replace if environment variables are explicitly set (not using relative URLs)
if [ -n "$API_URL" ] && [ "$API_URL" != "" ]; then
    sed -i "s#window.__API_URL__ || '[^']*'#window.__API_URL__ || '${API_URL_ESCAPED}'#g" /app/src/index.html
fi
if [ -n "$WS_URL" ] && [ "$WS_URL" != "" ]; then
    sed -i "s#window.__WS_URL__ || '[^']*'#window.__WS_URL__ || '${WS_URL_ESCAPED}'#g" /app/src/index.html
fi
if [ -n "$STRIPE_PUBLISHABLE_KEY" ] && [ "$STRIPE_PUBLISHABLE_KEY" != "" ]; then
    sed -i "s#window.__STRIPE_PUBLISHABLE_KEY__ || '[^']*'#window.__STRIPE_PUBLISHABLE_KEY__ || '${STRIPE_KEY_ESCAPED}'#g" /app/src/index.html
fi
# GA4 measurement ID from .secrets / env (never commit the real ID).
# Write gitignored public/runtime-config.js so bind-mounted index.html stays clean.
write_ga_runtime_config() {
  local target="$1"
  local id="${GOOGLE_ANALYTICS_MEASUREMENT_ID:-}"
  mkdir -p "$(dirname "$target")"
  case "$id" in
    G-[A-Za-z0-9]*)
      # Escape backslashes and single quotes for a single-quoted JS string
      local esc
      esc=$(printf '%s' "$id" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")
      printf "%s\n" "window.__GA_MEASUREMENT_ID__ = '${esc}';" >"$target"
      echo "[entrypoint] Google Analytics measurement ID written to $(basename "$target")"
      ;;
    '')
      printf "%s\n" "window.__GA_MEASUREMENT_ID__ = '';" >"$target"
      ;;
    *)
      printf "%s\n" "window.__GA_MEASUREMENT_ID__ = '';" >"$target"
      echo "[entrypoint] WARNING: ignoring invalid GOOGLE_ANALYTICS_MEASUREMENT_ID (expected G-…)"
      ;;
  esac
}
write_ga_runtime_config /app/public/runtime-config.js

# Sync version in commit-hash.ts from package.json (preserve existing git hash if .git is missing, e.g. Docker bind-mount of ./front only).
# Keep the container startable on failure, but never stay silent about regen outcome.
if [ -f /app/scripts/get-commit-hash.js ]; then
  echo "[entrypoint] Regenerating src/environments/commit-hash.ts ..."
  set +e
  HASH_OUT=$(node /app/scripts/get-commit-hash.js 2>&1)
  HASH_RC=$?
  set -e
  printf '%s\n' "$HASH_OUT"
  if [ "$HASH_RC" -eq 0 ]; then
    CH_VERSION=$(sed -n "s/^export const version = '\\([^']*\\)';$/\\1/p" /app/src/environments/commit-hash.ts 2>/dev/null || true)
    CH_HASH=$(sed -n "s/^export const commitHash = '\\([^']*\\)';$/\\1/p" /app/src/environments/commit-hash.ts 2>/dev/null || true)
    echo "[entrypoint] commit-hash.ts ready: version=${CH_VERSION:-unknown} commitHash=${CH_HASH:-unknown}"
    PKG_VERSION=$(node -p "require('/app/package.json').version" 2>/dev/null || true)
    if [ -n "$PKG_VERSION" ] && [ -n "$CH_VERSION" ] && [ "$CH_VERSION" != "$PKG_VERSION" ]; then
      # stdout so docker logs keep message order with the regen lines above
      echo "[entrypoint] WARNING: commit-hash.ts version (${CH_VERSION}) does not match package.json (${PKG_VERSION})"
    fi
  else
    echo "[entrypoint] WARNING: get-commit-hash.js failed (exit ${HASH_RC}); continuing with existing commit-hash.ts"
  fi
fi

# Optional: populate front/sites/<slug>/ and front/marketing-flat/ (docker-compose.dev mounts ./scripts → /pos-scripts)
if [ -f /pos-scripts/sync-all-marketing-sites.sh ] && [ "${SYNC_MARKETING_ON_START:-${SYNC_GUSTAZO_ON_START:-1}}" != "0" ]; then
  # Windows checkouts may expose CRLF through the bind mount. Execute a normalized
  # temporary copy without rewriting the user's host file.
  sed 's/\r$//' /pos-scripts/sync-all-marketing-sites.sh >/tmp/sync-all-marketing-sites.sh
  /bin/bash /tmp/sync-all-marketing-sites.sh || true
fi

# Execute the original command
exec "$@"
