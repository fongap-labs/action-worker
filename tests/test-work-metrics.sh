#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

README="$TMP_DIR/README.md"

cat > "$README" <<'EOF'
# Action Worker

<!-- work-metrics:start -->
old
<!-- work-metrics:end -->
EOF

export GITHUB_REPOSITORY="fongap/action-worker"
export WORK_METRICS_COUNTS_JSON='{"dispatch":1411,"pr_governance":12,"ai_review":9,"gate":12,"release_governance":3}'

node "$ROOT_DIR/scripts/update-work-metrics.ts" "$README"

grep -F 'Dispatch-1%2C411-2F80ED?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null
grep -F 'PR%20Governance-12-6366F1?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null
grep -F 'AI%20Review-9-8B5CF6?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null
grep -F 'Release%20Governance-3-14B8A6?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null
grep -F 'github/actions/workflow/status/fongap/action-worker/validate-ci.yml?branch=main&style=flat-square&label=Status&labelColor=5B5B5B' "$README" >/dev/null

python3 - "$README" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text(encoding="utf-8")
order = ["Dispatch-", "AI%20Review-", "PR%20Governance-", "Release%20Governance-", "Status"]
positions = [text.index(token) for token in order]
if positions != sorted(positions):
    raise SystemExit("AI Review must appear before PR Governance in metrics badges.")
PY

before="$(sha256sum "$README" | awk '{print $1}')"
node "$ROOT_DIR/scripts/update-work-metrics.ts" "$README"
after="$(sha256sum "$README" | awk '{print $1}')"

[ "$before" = "$after" ] || {
  echo "Metrics rendering is not idempotent." >&2
  exit 1
}

unset WORK_METRICS_COUNTS_JSON
export WORK_METRICS_INCREMENT_JSON='{"dispatch":1,"pr_governance":1,"ai_review":1,"release_governance":0}'

node "$ROOT_DIR/scripts/update-work-metrics.ts" "$README"

grep -F 'Dispatch-1%2C412-2F80ED?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null
grep -F 'PR%20Governance-13-6366F1?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null
grep -F 'AI%20Review-10-8B5CF6?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null
grep -F 'Release%20Governance-3-14B8A6?style=flat-square&labelColor=5B5B5B' "$README" >/dev/null

WORKFLOW="$ROOT_DIR/.github/workflows/update-work-metrics.yml"
grep -F 'actions/setup-node@v4' "$WORKFLOW" >/dev/null
grep -F 'node-version: 24' "$WORKFLOW" >/dev/null
grep -F 'node scripts/update-work-metrics.ts README.md' "$WORKFLOW" >/dev/null
grep -F 'GH_METRICS_TOKEN: ${{ secrets.GH_CONTROL_TOKEN || secrets.GH_METRICS_PAT || secrets.GH_EXECUTION_REPO_PAT || github.token }}' "$WORKFLOW" >/dev/null || {
  echo "Work metrics reads must prefer GH_CONTROL_TOKEN." >&2
  exit 1
}
grep -F 'GH_TOKEN: ${{ github.token }}' "$WORKFLOW" >/dev/null || {
  echo "Work metrics local writeback must use the repository-scoped GitHub token." >&2
  exit 1
}
grep -F '准备增量统计' "$WORKFLOW" >/dev/null
grep -F 'WORK_METRICS_INCREMENT_JSON' "$WORKFLOW" >/dev/null
grep -F 'SOURCE_RUN_ID' "$WORKFLOW" >/dev/null
grep -F '"repos/$GITHUB_REPOSITORY/pulls"' "$WORKFLOW" >/dev/null || {
  echo "Work metrics PR creation must use the REST pulls endpoint." >&2
  exit 1
}
if grep -F 'GH_TOKEN: ${{ secrets.GH_CONTROL_TOKEN || secrets.GH_METRICS_PAT || secrets.GH_EXECUTION_REPO_PAT }}' "$WORKFLOW" >/dev/null; then
  echo "Work metrics local PR creation must not depend on a cross-repository PAT." >&2
  exit 1
fi
grep -F '"repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/merge"' "$WORKFLOW" >/dev/null || {
  echo "Work metrics merge must use the REST merge endpoint." >&2
  exit 1
}
grep -F 'Cleanup failed metrics branch' "$WORKFLOW" >/dev/null || {
  echo "Failed metrics PR creation must clean its temporary branch." >&2
  exit 1
}
grep -F 'git push origin --delete "$BRANCH"' "$WORKFLOW" >/dev/null || {
  echo "Metrics failure cleanup must delete the temporary branch." >&2
  exit 1
}
if grep -F 'gh pr create' "$WORKFLOW" >/dev/null || grep -F 'gh pr merge' "$WORKFLOW" >/dev/null; then
  echo "Work metrics writeback must not depend on GraphQL PR commands." >&2
  exit 1
fi

echo "work metrics tests passed"
