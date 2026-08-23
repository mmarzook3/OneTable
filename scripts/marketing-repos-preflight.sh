#!/usr/bin/env bash
# Preflight for agent 005: scan satisfecho org repos named NNN_slug for pushes and open issues.
# Writes digest to stdout or AGENT_005_CTX file; sets G005_* for pos-cursor-loop.sh gating.
#
# Usage: marketing-repos-preflight.sh [digest_file]
# Env: POS_REPO_ROOT, AGENT_GH_ORG (default satisfecho), AGENT_005_STATE (override state json path)

set -euo pipefail

ROOT="${POS_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ORG="${AGENT_GH_ORG:-satisfecho}"
MANIFEST="${ROOT}/config/marketing-sites.json"
TASKDIR="${ROOT}/agents2/tasks"
STATE_DIR="${ROOT}/agents2/005-marketing-repos-reviewer"
STATE_FILE="${AGENT_005_STATE:-${STATE_DIR}/last-scan.json}"
STAMP_FILE="${STATE_DIR}/time-of-last-review.txt"
CTX="${1:-}"

G005_GH_OK=0
G005_GH_AUTH_FAILED=0
G005_NEW_REPOS=0
G005_CHANGED_REPOS=0
G005_UNTRACKED_ISSUES=0
G005_DEPLOY_CANDIDATES=0

log_section() { echo "$*"; }

repo_slug_from_name() {
  local name="$1"
  if [[ "$name" =~ ^[0-9]{3}_(.+)$ ]]; then
    echo "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]' | tr '_' '-'
  fi
}

manifest_has_repo() {
  local full="$1"
  jq -e --arg r "$full" '.sites[]? | select(.repo == $r)' "$MANIFEST" >/dev/null 2>&1
}

manifest_slug_for_repo() {
  jq -r --arg r "$1" '.sites[]? | select(.repo == $r) | .slug // empty' "$MANIFEST" 2>/dev/null | head -1
}

issue_linked_in_tasks() {
  local repo_full="$1" num="$2"
  local pat_repo pat_mkt
  pat_repo="${repo_full}/issues/${num}"
  pat_mkt="MKT-$(echo "$repo_full" | awk -F/ '{print $2}' | grep -oE '^[0-9]{3}')-${num}"
  local f bn
  shopt -s nullglob
  for f in "$TASKDIR"/*.md "$TASKDIR"/done/*/*/*/*.md; do
    [[ -f "$f" ]] || continue
    bn=$(basename "$f")
    [[ "$bn" == "README.md" ]] && continue
    if grep -qF "$pat_repo" "$f" 2>/dev/null || grep -qF "$pat_mkt" "$f" 2>/dev/null; then
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

stored_pushed_at() {
  local repo="$1"
  jq -r --arg r "$repo" '.repos[$r].pushed_at // empty' "$STATE_FILE" 2>/dev/null || true
}

latest_artifact_name() {
  local repo="$1"
  gh api "repos/${repo}/actions/artifacts?per_page=5" \
    --jq '[.artifacts[] | select(.expired == false)] | sort_by(.created_at) | reverse | .[0].name // empty' 2>/dev/null || true
}

latest_successful_run_at() {
  local repo="$1"
  gh api "repos/${repo}/actions/runs?per_page=1&status=completed&conclusion=success" \
    --jq '.workflow_runs[0].updated_at // empty' 2>/dev/null || true
}

write_state_repo() {
  local repo="$1" pushed_at="$2" artifact="${3:-}"
  python3 - "$STATE_FILE" "$repo" "$pushed_at" "$artifact" <<'PY'
import json, os, sys
path, repo, pushed, artifact = sys.argv[1:5]
data = {"repos": {}}
if os.path.isfile(path):
    with open(path) as f:
        data = json.load(f)
data.setdefault("repos", {})
entry = data["repos"].get(repo, {})
entry["pushed_at"] = pushed
if artifact:
    entry["last_artifact"] = artifact
data["repos"][repo] = entry
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(data, f, indent=2, sort_keys=True)
    f.write("\n")
PY
}

emit() {
  if [[ -n "$CTX" ]]; then
    echo "$*" >>"$CTX"
  else
    echo "$*"
  fi
}

mkdir -p "$STATE_DIR"
[[ -f "$STATE_FILE" ]] || echo '{"repos":{}}' >"$STATE_FILE"

utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [[ -n "$CTX" ]]; then
  : >"$CTX"
fi

emit "pos-agent-loop 005 marketing-repos preflight — ${utc} (UTC)"
emit "org: ${ORG}  manifest: ${MANIFEST}  state: ${STATE_FILE}"
emit ""

if ! command -v gh >/dev/null 2>&1; then
  emit "G005_GH_OK=0 (gh not on PATH)"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  emit "G005_GH_OK=0 (jq required)"
  exit 0
fi

gh_err="$(mktemp)"
repos_json="$(gh api "orgs/${ORG}/repos?per_page=100" --paginate 2>"$gh_err" || true)"
if [[ -z "$repos_json" ]]; then
  if grep -qiE '401|Bad credentials|not authenticated|gh auth login' "$gh_err" 2>/dev/null; then
    G005_GH_AUTH_FAILED=1
  fi
  emit "=== gh org repos FAILED ==="
  emit "$(cat "$gh_err" 2>/dev/null || true)"
  emit "G005_GH_OK=0"
  rm -f "$gh_err"
  exit 0
fi
rm -f "$gh_err"
G005_GH_OK=1

emit "=== Marketing repos (NNN_slug) ==="
while IFS=$'\t' read -r name full pushed_at; do
  [[ -z "$name" ]] && continue
  slug="$(repo_slug_from_name "$name")"
  [[ -n "$slug" ]] || continue

  in_manifest="no"
  manifest_has_repo "$full" && in_manifest="yes"
  prev="$(stored_pushed_at "$full")"
  changed="no"
  if [[ -n "$prev" && "$pushed_at" != "$prev" ]]; then
    changed="yes"
    G005_CHANGED_REPOS=$((G005_CHANGED_REPOS + 1))
  elif [[ -z "$prev" && "$in_manifest" == "no" ]]; then
    G005_NEW_REPOS=$((G005_NEW_REPOS + 1))
    changed="new"
  elif [[ -z "$prev" && "$in_manifest" == "yes" ]]; then
    # First scan baseline for already-registered sites — not actionable "new repo"
    changed="baseline"
  fi

  artifact="$(latest_artifact_name "$full")"
  run_ok_at="$(latest_successful_run_at "$full")"
  deploy_hint=""
  if [[ "$in_manifest" == "yes" && "$changed" == "yes" && -n "$run_ok_at" ]]; then
    G005_DEPLOY_CANDIDATES=$((G005_DEPLOY_CANDIDATES + 1))
    deploy_hint="deploy_candidate=yes"
  elif [[ "$in_manifest" == "no" && "$changed" == "new" ]]; then
    deploy_hint="register_in_manifest=yes"
  fi

  emit "- ${full} slug=${slug} in_manifest=${in_manifest} pushed_at=${pushed_at} prev=${prev:-none} changed=${changed} artifact=${artifact:-unknown} ${deploy_hint}"
  if [[ "${MARKETING_PREFLIGHT_READONLY:-0}" != "1" ]]; then
    write_state_repo "$full" "$pushed_at" "$artifact"
  fi

  emit ""
  emit "=== Open issues: ${full} ==="
  issues_json="$(gh issue list --repo "$full" --state open --limit 20 --json number,title,url,labels 2>/dev/null || echo '[]')"
  count=$(echo "$issues_json" | jq 'length')
  if [[ "$count" -eq 0 ]]; then
    emit "(none)"
  else
    while IFS= read -r row; do
      [[ -z "$row" ]] && continue
      num=$(echo "$row" | jq -r '.number')
      title=$(echo "$row" | jq -r '.title')
      url=$(echo "$row" | jq -r '.url')
      labels=$(echo "$row" | jq -r '[.labels[].name] | join(", ")')
      skip=""
      echo "$labels" | grep -q 'agent:planned' && skip="skip:agent:planned"
      issue_linked_in_tasks "$full" "$num" && skip="skip:linked"
      if [[ -z "$skip" ]]; then
        G005_UNTRACKED_ISSUES=$((G005_UNTRACKED_ISSUES + 1))
        emit "UNTRACKED #${num} ${title} ${url} labels=[${labels}]"
      else
        emit "SKIP #${num} ${title} (${skip})"
      fi
    done < <(echo "$issues_json" | jq -c '.[]')
  fi
  emit ""
done < <(echo "$repos_json" | jq -r '.[] | select(.name | test("^[0-9]{3}_")) | [.name, .full_name, .pushed_at] | @tsv' | sort)

emit "=== Summary ==="
emit "G005_GH_OK=${G005_GH_OK}"
emit "G005_GH_AUTH_FAILED=${G005_GH_AUTH_FAILED}"
emit "G005_NEW_REPOS=${G005_NEW_REPOS}"
emit "G005_CHANGED_REPOS=${G005_CHANGED_REPOS}"
emit "G005_UNTRACKED_ISSUES=${G005_UNTRACKED_ISSUES}"
emit "G005_DEPLOY_CANDIDATES=${G005_DEPLOY_CANDIDATES}"
emit "live_url_pattern: https://scanaski.uk/<slug>/ (e.g. /wimpi/)"

if [[ "${MARKETING_PREFLIGHT_READONLY:-0}" != "1" ]]; then
  printf '%s UTC | 005 preflight | new=%s changed=%s untracked_issues=%s deploy_candidates=%s\n\n' \
    "$utc" "$G005_NEW_REPOS" "$G005_CHANGED_REPOS" "$G005_UNTRACKED_ISSUES" "$G005_DEPLOY_CANDIDATES" >>"$STAMP_FILE"
fi
