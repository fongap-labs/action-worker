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
        echo "ERROR: missing PR policy contract: $value" >&2
        exit 1
    }
}

forbid() {
    local pattern="$1"
    if grep -qE "$pattern" "$WORKFLOW"; then
        echo "ERROR: forbidden PR policy coupling: $pattern" >&2
        exit 1
    fi
}

require "repository_dispatch:"
require "types: [run-pr-governance]"
require "validate-pr-payload.sh"
require "validate-pr-repository.sh"
require "validate-change-record.sh"
require "detect-pr-context.sh"
require "resolve-pr-plan.sh"
require "review_model"
require "wait-review-turn.sh"
require "run-ai-triage.sh"
require "apply-ai-triage.sh"
require "validate-naming-rules.sh"
require "PR_REPOSITORY_ALLOWLIST"
require "GH_CONTROL_TOKEN"
require "AI_GATEWAY_URL"
require "GATEWAY_ACCESS_KEY_AIR"
require "install-ocr.sh"
require "actions/cache@v4"
forbid "@alibaba-group/open-code-review"
forbid "npm install -g"
require "rules/"
require "set-pr-status.sh"
require "publish-pr-review.sh"
require "should-resume-ocr.sh"
require '--resume "$session_id"'

forbid "workflow_call:"
forbid 'profile:'
forbid 'core|infra|light'
forbid 'delta|delta-suite|ai-gateway|server-edge|internal-vault|external-vault'

echo "PR policy contract tests passed."
