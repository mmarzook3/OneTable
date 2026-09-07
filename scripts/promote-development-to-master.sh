#!/usr/bin/env bash
# Promote origin/development → origin/master when the cadence allows (default: daily).
# Pushing master triggers GitHub Actions "Deploy to amvara9".
#
# Usage (from repo root):
#   ./scripts/promote-development-to-master.sh
#   AGENT_PROMOTE_FORCE=1 ./scripts/promote-development-to-master.sh
#   AGENT_PROMOTE_DRY_RUN=1 ./scripts/promote-development-to-master.sh
#
# Environment:
#   AGENT_PROMOTE=0                    Disable (exit 0).
#   AGENT_PROMOTE_INTERVAL_HOURS       Min hours since last master tip (default: 24).
#   AGENT_PROMOTE_FORCE=1              Ignore cadence; still no-ops if already up to date.
#   AGENT_PROMOTE_DRY_RUN=1            Print plan only; no merge/push/release.
#   AGENT_PROMOTE_CREATE_RELEASE=0     Skip GitHub release creation (default: create if missing).
#   AGENT_PROMOTE_WAIT_DEPLOY=1        Poll "Deploy to amvara9" until completed (default: 0).
#   AGENT_PROMOTE_WAIT_MINUTES         Max wait when WAIT_DEPLOY=1 (default: 45).
#   AGENT_GH_REPO                      Default satisfecho/pos.
#
# Exit codes: 0 = promoted or clean skip; 1 = error / blocked; 2 = skipped (cadence / disabled).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The Scanaki fork uses protected pull requests and its own deployment workflow.
# Never let the legacy daily loop deploy the unrelated origin repository.
if git remote get-url scanaki 2>/dev/null | grep -q 'mmarzook3/OneTable'; then
  echo "Scanaki promotion requires a checked pull request from development to master in mmarzook3/OneTable." >&2
  exit 2
fi

GH_REPO="${AGENT_GH_REPO:-satisfecho/pos}"
INTERVAL_HOURS="${AGENT_PROMOTE_INTERVAL_HOURS:-24}"
FORCE="${AGENT_PROMOTE_FORCE:-0}"
DRY_RUN="${AGENT_PROMOTE_DRY_RUN:-0}"
CREATE_RELEASE="${AGENT_PROMOTE_CREATE_RELEASE:-1}"
WAIT_DEPLOY="${AGENT_PROMOTE_WAIT_DEPLOY:-0}"
WAIT_MINUTES="${AGENT_PROMOTE_WAIT_MINUTES:-45}"

log() { echo "----- promote: $*" >&2; }

if [[ "${AGENT_PROMOTE:-1}" == "0" ]]; then
  log "disabled (AGENT_PROMOTE=0)"
  exit 2
fi

# Stale env tokens break gh; prefer keyring when env auth fails.
if command -v gh >/dev/null 2>&1 && [[ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]]; then
  if ! gh api user -q .login >/dev/null 2>&1; then
    log "invalid GITHUB_TOKEN/GH_TOKEN — unsetting for keyring auth"
    unset GITHUB_TOKEN GH_TOKEN
  fi
fi

# Dirty tree (except allowlisted reviewer stamps) would risk checkout/merge damage.
dirty_blockers() {
  local f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$f" in
      agents2/001-gh-reviewer/time-of-last-review.txt) ;;
      agents2/005-marketing-repos-reviewer/time-of-last-review.txt) ;;
      agents2/005-marketing-repos-reviewer/last-scan.json) ;;
      agents2/008-enhancement-reviewer/time-of-last-review.txt) ;;
      agents2/008-enhancement-reviewer/last-scan.json) ;;
      *) echo "$f" ;;
    esac
  done < <({
    git diff --name-only HEAD 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
  } | sort -u)
}

blockers="$(dirty_blockers || true)"
if [[ -n "$blockers" ]]; then
  log "blocked: dirty working tree (commit or stash first):"
  echo "$blockers" >&2
  exit 1
fi

STAMP_PATHS=(
  agents2/001-gh-reviewer/time-of-last-review.txt
  agents2/005-marketing-repos-reviewer/time-of-last-review.txt
  agents2/005-marketing-repos-reviewer/last-scan.json
  agents2/008-enhancement-reviewer/time-of-last-review.txt
  agents2/008-enhancement-reviewer/last-scan.json
)
STASHED_STAMPS=0

stash_stamps_if_needed() {
  local existing=()
  local p
  for p in "${STAMP_PATHS[@]}"; do
    if ! git diff --quiet -- "$p" 2>/dev/null || ! git diff --staged --quiet -- "$p" 2>/dev/null; then
      existing+=("$p")
    elif [[ -n "$(git ls-files --others --exclude-standard -- "$p" 2>/dev/null || true)" ]]; then
      existing+=("$p")
    fi
  done
  if ((${#existing[@]} == 0)); then
    return 0
  fi
  log "stashing allowlisted reviewer stamps for branch switch (${#existing[@]} file(s))"
  git stash push -u -m "promote-tmp-stamps" -- "${existing[@]}" >/dev/null
  STASHED_STAMPS=1
}

restore_stamps_stash() {
  if [[ "$STASHED_STAMPS" != "1" ]]; then
    return 0
  fi
  log "restoring stashed reviewer stamps"
  git stash pop --index >/dev/null 2>&1 || git stash pop >/dev/null 2>&1 || log "warning: could not restore stamp stash (check git stash list)"
  STASHED_STAMPS=0
}

log "git fetch origin development master"
git fetch origin development master

DEV_SHA="$(git rev-parse --short origin/development)"
MASTER_SHA="$(git rev-parse --short origin/master)"
AHEAD="$(git rev-list --count origin/master..origin/development)"
VERSION="$(git show "origin/development:front/package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"

log "development=${DEV_SHA} master=${MASTER_SHA} ahead=${AHEAD} version=${VERSION}"

if [[ "$AHEAD" -eq 0 ]]; then
  log "skip: master already contains development tip"
  exit 0
fi

MASTER_EPOCH="$(git log -1 --format=%ct origin/master)"
NOW_EPOCH="$(date +%s)"
AGE_HOURS=$(( (NOW_EPOCH - MASTER_EPOCH) / 3600 ))
log "master tip age ≈ ${AGE_HOURS}h (interval=${INTERVAL_HOURS}h force=${FORCE})"

if [[ "$FORCE" != "1" && "$AGE_HOURS" -lt "$INTERVAL_HOURS" ]]; then
  log "skip: cadence not due yet (${AGE_HOURS}h < ${INTERVAL_HOURS}h). Set AGENT_PROMOTE_FORCE=1 to promote now."
  exit 2
fi

SUBJECT="Merge development: release through ${VERSION} (daily promote; ${AHEAD} commit(s) from ${DEV_SHA})."

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN: would checkout master, merge origin/development, push origin master"
  log "DRY_RUN: merge subject: ${SUBJECT}"
  if [[ "$CREATE_RELEASE" != "0" ]]; then
    log "DRY_RUN: would ensure GitHub release v${VERSION} if missing"
  fi
  exit 0
fi

PREV_BRANCH="$(git branch --show-current)"
RESTORE_BRANCH="${PREV_BRANCH:-development}"

cleanup() {
  local rc=$?
  if git rev-parse --verify "refs/heads/${RESTORE_BRANCH}" >/dev/null 2>&1; then
    git checkout -q "$RESTORE_BRANCH" 2>/dev/null || true
  fi
  restore_stamps_stash
  if [[ "$rc" -ne 0 ]]; then
    log "failed (exit ${rc}); restored branch ${RESTORE_BRANCH}"
  fi
}
trap cleanup EXIT

stash_stamps_if_needed

log "checkout master @ origin/master"
git checkout -B master origin/master

log "merge origin/development"
if ! git merge --no-ff origin/development -m "$SUBJECT"; then
  log "merge conflict — aborting"
  git merge --abort 2>/dev/null || true
  exit 1
fi

MERGE_SHA="$(git rev-parse --short HEAD)"
MERGE_FULL="$(git rev-parse HEAD)"
log "push origin master (${MERGE_SHA})"
git push origin master

# Restore prior branch (development tip is unchanged; do not reset --hard).
git checkout -q "$RESTORE_BRANCH"
restore_stamps_stash
trap - EXIT

log "promoted: master=${MERGE_SHA} (from development ${DEV_SHA}, version ${VERSION})"

if [[ "$CREATE_RELEASE" != "0" ]] && command -v gh >/dev/null 2>&1; then
  if gh release view "v${VERSION}" --repo "$GH_REPO" >/dev/null 2>&1; then
    log "GitHub release v${VERSION} already exists"
  else
    NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/promote-notes.XXXXXX")"
    python3 - "$VERSION" "$NOTES_FILE" <<'PY'
import re, sys
version, out = sys.argv[1], sys.argv[2]
text = open("CHANGELOG.md", encoding="utf-8").read()
pat = rf"## \[{re.escape(version)}\][^\n]*\n(.*?)(?=\n## \[|\Z)"
m = re.search(pat, text, re.S)
body = (m.group(1).strip() if m else f"Release {version}.")
open(out, "w", encoding="utf-8").write(body + "\n")
PY
    log "creating GitHub release v${VERSION}"
    if gh release create "v${VERSION}" --repo "$GH_REPO" --target master \
      --title "v${VERSION}" --notes-file "$NOTES_FILE"; then
      log "release created: https://github.com/${GH_REPO}/releases/tag/v${VERSION}"
    else
      log "warning: gh release create failed (non-fatal)"
    fi
    rm -f "$NOTES_FILE"
  fi
fi

if [[ "$WAIT_DEPLOY" == "1" ]] && command -v gh >/dev/null 2>&1; then
  log "waiting for Deploy to amvara9 (up to ${WAIT_MINUTES}m)"
  deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
  run_status=""
  run_conclusion=""
  run_id=""
  while (( $(date +%s) < deadline )); do
    run_json="$(gh run list --repo "$GH_REPO" --workflow "Deploy to amvara9" --branch master --limit 15 \
      --json databaseId,headSha,status,conclusion 2>/dev/null || echo '[]')"
    eval "$(python3 -c '
import json, sys
runs = json.loads(sys.argv[1] or "[]")
want = sys.argv[2]
# Exact SHA only — never fall back to an older successful run.
pick = next((r for r in runs if r.get("headSha") == want), None)
if not pick:
    print("run_id=\"\"; run_status=\"\"; run_conclusion=\"\"")
else:
    print(
        "run_id=%r; run_status=%r; run_conclusion=%r"
        % (str(pick["databaseId"]), pick.get("status") or "", pick.get("conclusion") or "")
    )
' "$run_json" "$MERGE_FULL")"
    if [[ -n "$run_id" ]]; then
      log "deploy run ${run_id} status=${run_status} conclusion=${run_conclusion:-pending}"
      if [[ "$run_status" == "completed" ]]; then
        if [[ "$run_conclusion" == "success" ]]; then
          log "Deploy to amvara9 succeeded: https://github.com/${GH_REPO}/actions/runs/${run_id}"
          break
        fi
        log "Deploy to amvara9 finished with conclusion=${run_conclusion}"
        exit 1
      fi
    else
      log "waiting for workflow run for ${MERGE_FULL:0:12}…"
    fi
    sleep 20
  done
  if [[ "${run_status:-}" != "completed" || "${run_conclusion:-}" != "success" ]]; then
    log "timed out waiting for successful deploy of ${MERGE_FULL}"
    exit 1
  fi
fi

exit 0
