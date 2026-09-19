#!/usr/bin/env bash

set -Eeuo pipefail

WORKFLOW=".github/workflows/handle-pr-dispatch.yml"

[ -f "$WORKFLOW" ] || {
    echo "ERROR: $WORKFLOW not found." >&2
    exit 1
}

require() {
    local value="$1"
    grep -qF -- "$value" "$WORKFLOW" || {
        echo "ERROR: missing PR boundary contract: $value" >&2
        exit 1
    }
}

forbid() {
    local pattern="$1"
    if grep -qE "$pattern" "$WORKFLOW"; then
        echo "ERROR: forbidden PR boundary pattern: $pattern" >&2
        exit 1
    fi
}

require "repository_dispatch:"
require "types: [run-pr-governance]"
require 'pr-governance-${{ github.event.client_payload.repository }}-${{ github.event.client_payload.pr_number }}'
require "PR_REPOSITORY_ALLOWLIST"
require "GH_CONTROL_TOKEN"
require "AI_GATEWAY_URL"
require "GATEWAY_ACCESS_KEY_AIR"
require "path: target"
require "id: resolved"
require "PR Head 在调度后已更新"
require "persist-credentials: false"
require "validate-pr-payload.sh"
require "validate-pr-repository.sh"
require "validate-control-access.sh"
require "set-pr-status.sh"
require "publish-pr-review.sh"
require "validate-review-result.sh"
require "wait-ci-evidence.sh"
require "validate-ci-evidence.sh"
require ".action-worker-ci-evidence.json"
require "rm -f target/.action-worker-ci-evidence.json"
require "install -m 0600 /tmp/ci-evidence.json target/.action-worker-ci-evidence.json"
require "build-review-comparison.sh"
require 'review_base_sha="$BASE_SHA"'
require 'review_head_sha="$HEAD_SHA"'
require '--from "$review_base_sha"'
require '--to "$review_head_sha"'
require "ci_required"
require "收集 CI 证据"
require "OCR_LLM_TIMEOUT"
require "REVIEW_TASK_TIMEOUT"
require "REVIEW_CONCURRENCY"
require "wait-review-turn.sh"
require "run-ai-triage.sh"
require "apply-ai-triage.sh"
require 'fallback is owned by AI Gateway'
require 'ocr review'
require '--timeout "$REVIEW_TASK_TIMEOUT"'
require '--concurrency "$REVIEW_CONCURRENCY"'
require "Resolve governance ownership"
require "check-status-owner.sh"
require "steps.ownership.outputs.current == 'true'"
forbid 'ocr[[:space:]]+llm[[:space:]]+test'
forbid 'pr-governance-.*github\.sha'
forbid 'review_models'
forbid 'review-diff-fallback'
forbid 'validate-ocr-roundtrip'
forbid 'from "\$BASE_SHA"'
forbid 'to "\$HEAD_SHA"'
require "install-ocr.sh"
require "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0"
forbid "@alibaba-group/open-code-review"
forbid "npm install -g"
require "report-ocr-retry.sh"
require "should-resume-ocr.sh"
require '--resume "$session_id"'
require "resume_budget=1"
require 'sleep "$backoff_seconds"'

forbid 'env:[[:space:]]*\$\{\{[[:space:]]*secrets[[:space:]]*\}\}'
forbid 'bash[[:space:]]+target/'
forbid '(^|[^A-Za-z0-9_-])(delta|delta-suite|ai-gateway|server-edge|internal-vault|external-vault)([^A-Za-z0-9_-]|$)'

echo "PR trust boundary tests passed."

python3 - "$WORKFLOW" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
order = ["- name: 收集 CI 证据", "- name: Wait for AI queue", "- name: Run AI Triage", "- name: Resolve final plan", "- name: 执行 AI 审查", "- name: 校验 CI 证据", "- name: 更新最终门禁"]
positions = [text.index(token) for token in order]
if positions != sorted(positions):
    raise SystemExit("ERROR: CI evidence ordering is invalid.")
PY
