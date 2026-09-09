#!/usr/bin/env bash
# Default NOOP. Capture/rehearse do not authorize a live rollback.
# FUTURE INCIDENT ONLY, after review and pausing all deployment writers:
# bash scripts/scanaki-rollback-baseline.sh rollback --execute \
#   --expected-current-sha CURRENT_40_HEX --baseline-sha256 RECORDED_64_HEX \
#   --deployments-paused --allow-live-cutover
# Escalation: alerts@scanaki.uk. No database restore/downgrade is implemented.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/phase4-rollback-rehearsal.py" "$@"
