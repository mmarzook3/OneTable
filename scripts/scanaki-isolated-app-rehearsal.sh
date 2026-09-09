#!/usr/bin/env bash
# Review before execution. Encrypted input must be the approved Drive-mounted copy
# transferred to /opt/scanaki/app/tmp/phase4-offsite/<set>/bundle.tar.enc.
# Usage: SCANAKI_BACKUP_PASSPHRASE=<private env> bash "$0" --execute BUNDLE SHA BACK FRONT PG
# No production cutover. Rollback scope is preserved frontend HTTP assets only.
set -euo pipefail
set +x
umask 077
exec python3 "$(dirname "$0")/phase4-recovery-probe.py" "$@"
