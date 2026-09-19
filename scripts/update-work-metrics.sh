#!/usr/bin/env bash
set -Eeuo pipefail

README_PATH="${1:-README.md}"
API_URL="${GITHUB_API_URL:-https://api.github.com}"
REPOSITORY="${GITHUB_REPOSITORY:-fongap/action-worker}"
OWNER="${GITHUB_REPOSITORY_OWNER:-${REPOSITORY%%/*}}"
TOKEN="${GH_METRICS_TOKEN:-${GITHUB_TOKEN:-}}"
REPOSITORIES_JSON="${METRICS_REPOSITORIES_JSON:-}"
COUNTS_JSON="${WORK_METRICS_COUNTS_JSON:-}"
INCREMENT_JSON="${WORK_METRICS_JSON:-}"

command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 69; }
command -v jq >/dev/null 2>&1 || { echo "jq is required." >&2; exit 69; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required." >&2; exit 69; }
[ -f "$README_PATH" ] || { echo "README not found: $README_PATH" >&2; exit 66; }

headers=(
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2022-11-28"
)
if [ -n "$TOKEN" ]; then
  headers+=(-H "Authorization: Bearer $TOKEN")
fi

api_get() {
  local url="$1"
  curl -fsSL \
    --retry 3 \
    --retry-delay 2 \
    --retry-all-errors \
    "${headers[@]}" \
    "$url"
}

declare -a repositories=()

add_repository() {
  local repository="$1"

  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "Invalid repository name: $repository" >&2
    exit 65
  }

  local current
  for current in "${repositories[@]:-}"; do
    [ "$current" = "$repository" ] && return 0
  done

  repositories+=("$repository")
}

discover_repositories() {
  add_repository "$REPOSITORY"

  if [ -n "$REPOSITORIES_JSON" ]; then
    jq -e '
      type == "array"
      and all(.[];
        type == "string"
        and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
      )
    ' <<< "$REPOSITORIES_JSON" >/dev/null || {
      echo "METRICS_REPOSITORIES_JSON must be a JSON array of owner/repository values." >&2
      exit 65
    }

    while IFS= read -r repository; do
      add_repository "$repository"
    done < <(jq -r '.[]' <<< "$REPOSITORIES_JSON")

    return 0
  fi

  local page=1
  local response count repository
  while :; do
    response="$(api_get "$API_URL/users/$OWNER/repos?type=owner&per_page=100&page=$page")"
    count="$(jq 'length' <<< "$response")"

    while IFS= read -r repository; do
      add_repository "$repository"
    done < <(jq -r '.[].full_name' <<< "$response")

    [ "$count" -lt 100 ] && break
    page=$((page + 1))
  done

  if [ -n "$TOKEN" ]; then
    page=1
    while :; do
      set +e
      response="$(api_get "$API_URL/user/repos?affiliation=owner&per_page=100&page=$page" 2>/dev/null)"
      local rc=$?
      set -e

      if [ "$rc" -ne 0 ]; then
        echo "::warning::当前统计凭据无法枚举私有仓库，仅统计可访问仓库。" >&2
        break
      fi

      count="$(jq 'length' <<< "$response")"

      while IFS= read -r repository; do
        add_repository "$repository"
      done < <(jq -r --arg owner "$OWNER" '.[] | select(.owner.login == $owner) | .full_name' <<< "$response")

      [ "$count" -lt 100 ] && break
      page=$((page + 1))
    done
  fi
}

dispatch_count=0
governance_count=0
ai_review_count=0
gate_count=0
release_count=0

collect_metrics() {
  discover_repositories

  local repository page response count

  for repository in "${repositories[@]}"; do
    page=1

    while :; do
      response="$(api_get "$API_URL/repos/$repository/actions/runs?per_page=100&page=$page")" || {
        echo "Unable to read Actions runs for $repository." >&2
        exit 77
      }

      count="$(jq '.workflow_runs | length' <<< "$response")"

      if [ "$repository" = "$REPOSITORY" ]; then
        dispatch_count=$((dispatch_count + $(jq '
          [.workflow_runs[]
            | select(.path == ".github/workflows/handle-task-dispatch.yml")
            | select(.event == "repository_dispatch")
            | select(.conclusion == "success")]
          | length
        ' <<< "$response")))

        governance_count=$((governance_count + $(jq '
          [.workflow_runs[]
            | select(.path == ".github/workflows/handle-pr-dispatch.yml")
            | select(.event == "repository_dispatch")
            | select(.conclusion == "success")]
          | length
        ' <<< "$response")))

        while IFS= read -r run_id; do
          [ -n "$run_id" ] || continue
          jobs_response="$(api_get "$API_URL/repos/$REPOSITORY/actions/runs/$run_id/jobs?per_page=100")"

          if jq -e '
            [.jobs[].steps[]?
              | select(.name == "执行 AI 审查")
              | select(.conclusion == "success")]
            | length > 0
          ' <<< "$jobs_response" >/dev/null; then
            ai_review_count=$((ai_review_count + 1))
          fi

          if jq -e '
            [.jobs[].steps[]?
              | select(.name == "更新最终门禁")
              | select(.conclusion == "success")]
            | length > 0
          ' <<< "$jobs_response" >/dev/null; then
            gate_count=$((gate_count + 1))
          fi
        done < <(jq -r '
          .workflow_runs[]
          | select(.path == ".github/workflows/handle-pr-dispatch.yml")
          | select(.event == "repository_dispatch")
          | select(.conclusion == "success")
          | .id
        ' <<< "$response")

        release_count=$((release_count + $(jq '
          [.workflow_runs[]
            | select(.path == ".github/workflows/handle-release-dispatch.yml")
            | select(.event == "repository_dispatch")
            | select(.conclusion == "success")]
          | length
        ' <<< "$response")))
      fi

      [ "$count" -lt 100 ] && break
      page=$((page + 1))
    done
  done
}

load_increment() {
  jq -e '
    def valid_count($key):
      ((.[$key] // 0) | type == "number" and . >= 0 and floor == .);
    type == "object"
    and valid_count("dispatch")
    and valid_count("pr_governance")
    and valid_count("ai_review")
    and valid_count("release_governance")
  ' <<< "$INCREMENT_JSON" >/dev/null || {
    echo "WORK_METRICS_JSON is invalid." >&2
    exit 65
  }

  mapfile -t current_counts < <(
    python3 - "$README_PATH" <<'PY'
from pathlib import Path
from urllib.parse import unquote
import re
import sys

content = Path(sys.argv[1]).read_text(encoding="utf-8")
labels = [
    "Dispatch",
    "PR%20Governance",
    "AI%20Review",
    "Release%20Governance",
]

for label in labels:
    match = re.search(
        rf"img\.shields\.io/badge/{re.escape(label)}-([0-9%2C]+)-",
        content,
    )
    if not match:
        raise SystemExit(f"README metric badge not found: {label}")
    value = unquote(match.group(1)).replace(",", "")
    if not value.isdigit():
        raise SystemExit(f"README metric value is invalid: {label}={value}")
    print(value)
PY
  )

  dispatch_count=$((current_counts[0] + $(jq -r '.dispatch // 0' <<< "$INCREMENT_JSON")))
  governance_count=$((current_counts[1] + $(jq -r '.pr_governance // 0' <<< "$INCREMENT_JSON")))
  ai_review_count=$((current_counts[2] + $(jq -r '.ai_review // 0' <<< "$INCREMENT_JSON")))
  release_count=$((current_counts[3] + $(jq -r '.release_governance // 0' <<< "$INCREMENT_JSON")))
  gate_count="$governance_count"
}

load_fixture() {
  jq -e '
    type == "object"
    and (.dispatch | type == "number" and . >= 0)
    and (.pr_governance | type == "number" and . >= 0)
    and (.ai_review | type == "number" and . >= 0)
    and (.gate | type == "number" and . >= 0)
    and (.release_governance | type == "number" and . >= 0)
  ' <<< "$COUNTS_JSON" >/dev/null || {
    echo "WORK_METRICS_COUNTS_JSON is invalid." >&2
    exit 65
  }

  dispatch_count="$(jq -r '.dispatch' <<< "$COUNTS_JSON")"
  governance_count="$(jq -r '.pr_governance' <<< "$COUNTS_JSON")"
  ai_review_count="$(jq -r '.ai_review' <<< "$COUNTS_JSON")"
  gate_count="$(jq -r '.gate' <<< "$COUNTS_JSON")"
  release_count="$(jq -r '.release_governance' <<< "$COUNTS_JSON")"
}

if [ -n "$COUNTS_JSON" ]; then
  load_fixture
elif [ -n "$INCREMENT_JSON" ]; then
  load_increment
else
  collect_metrics
fi

python3 - "$README_PATH" "$dispatch_count" "$governance_count" "$ai_review_count" "$gate_count" "$release_count" "$REPOSITORY" <<'PY'
from pathlib import Path
from urllib.parse import quote
import re
import sys

path = Path(sys.argv[1])
dispatch = int(sys.argv[2])
governance = int(sys.argv[3])
ai_review = int(sys.argv[4])
gate = int(sys.argv[5])
release_governance = int(sys.argv[6])
repository = sys.argv[7]

def message(value: int) -> str:
    return quote(f"{value:,}", safe="")

block = f"""<!-- work-metrics:start -->
[![Dispatch](https://img.shields.io/badge/Dispatch-{message(dispatch)}-2F80ED?style=flat-square&labelColor=5B5B5B)](https://github.com/{repository}/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-{message(ai_review)}-8B5CF6?style=flat-square&labelColor=5B5B5B)](https://github.com/{repository}/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-{message(governance)}-6366F1?style=flat-square&labelColor=5B5B5B)](https://github.com/{repository}/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-{message(release_governance)}-14B8A6?style=flat-square&labelColor=5B5B5B)](https://github.com/{repository}/releases) [![Status](https://img.shields.io/github/actions/workflow/status/{repository}/validate-ci.yml?branch=main&style=flat-square&label=Status&labelColor=5B5B5B)](https://github.com/{repository}/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->"""

content = path.read_text(encoding="utf-8")
pattern = re.compile(
    r"<!-- work-metrics:start -->.*?<!-- work-metrics:end -->",
    re.DOTALL,
)

if not pattern.search(content):
    raise SystemExit("README work metrics markers were not found.")

updated = pattern.sub(block, content, count=1)
path.write_text(updated, encoding="utf-8")
PY

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "dispatch=$dispatch_count"
    echo "pr_governance=$governance_count"
    echo "ai_review=$ai_review_count"
    echo "gate=$gate_count"
    echo "release_governance=$release_count"
  } >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## 工作统计"
    echo
    echo "- Dispatch: $dispatch_count"
    echo "- PR Governance: $governance_count"
    echo "- AI Review: $ai_review_count"
    echo "- Gate: $gate_count"
    echo "- Release Governance: $release_count"
    if [ -n "$INCREMENT_JSON" ]; then
      echo "- Mode: incremental"
    else
      echo "- Repositories: ${#repositories[@]}"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

printf 'Dispatch=%s PR Governance=%s AI Review=%s Gate=%s Release Governance=%s\n' \
  "$dispatch_count" "$governance_count" "$ai_review_count" "$gate_count" "$release_count"
