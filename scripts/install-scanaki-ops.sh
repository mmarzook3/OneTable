#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
APP_DIR="${SCANAKI_APP_DIR:-/opt/scanaki/app}"
cd "$APP_DIR"
[[ -f config.env ]] || { echo "$APP_DIR/config.env is required" >&2; exit 1; }

install -d -m 700 /etc/scanaki
OPS_ENV=/etc/scanaki/ops.env
if [[ ! -f "$OPS_ENV" ]]; then
  PASSPHRASE="$(openssl rand -base64 48 | tr -d '\n')"
  COMPOSE_FILE="docker-compose.prod.yml"
  [[ -f docker-compose.scanaki.yml ]] && COMPOSE_FILE="docker-compose.scanaki.yml"
  umask 077
  {
    printf 'SCANAKI_APP_DIR=%q\n' "$APP_DIR"
    printf 'SCANAKI_COMPOSE_FILE=%q\n' "$COMPOSE_FILE"
    printf 'SCANAKI_BASE_URL=%q\n' "${SCANAKI_BASE_URL:-https://scanaki.uk}"
    printf 'SCANAKI_BACKUP_DIR=%q\n' "$APP_DIR/backups/scanaki"
    printf 'SCANAKI_BACKUP_RETAIN=14\n'
    printf 'SCANAKI_BACKUP_PASSPHRASE=%q\n' "$PASSPHRASE"
    printf 'SCANAKI_ALERT_EMAIL=alerts@scanaki.uk\n'
    printf 'SCANAKI_ALERT_WEBHOOK_URL=\n'
  } >"$OPS_ENV"
fi
chmod 600 "$OPS_ENV"

install -m 600 /dev/null /var/log/scanaki-ops.log 2>/dev/null || true
cat >/etc/logrotate.d/scanaki-ops <<'EOF'
/var/log/scanaki-ops.log {
  weekly
  rotate 12
  compress
  missingok
  notifempty
  copytruncate
}
EOF
chmod 644 /etc/logrotate.d/scanaki-ops

cat >/etc/cron.d/scanaki-ops <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root $APP_DIR/scripts/scanaki-ops-run.sh health >/dev/null 2>&1
20 2 * * * root $APP_DIR/scripts/scanaki-ops-run.sh backup >/dev/null 2>&1
35 3 * * 0 root $APP_DIR/scripts/scanaki-ops-run.sh restore-latest >/dev/null 2>&1
EOF
chmod 644 /etc/cron.d/scanaki-ops

"$APP_DIR/scripts/scanaki-ops-run.sh" backup
"$APP_DIR/scripts/scanaki-ops-run.sh" restore-latest
"$APP_DIR/scripts/scanaki-ops-run.sh" health
echo "Scanaki operations installed: backups daily, health every five minutes, restore check weekly"
