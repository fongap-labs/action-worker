#!/usr/bin/env bash

set -Eeuo pipefail

WORKFLOW=".github/workflows/validate-ci.yml"

[ -f "$WORKFLOW" ] || {
    echo "ERROR: $WORKFLOW not found." >&2
    exit 1
}

require() {
    local value="$1"
    grep -qF "$value" "$WORKFLOW" || {
        echo "ERROR: missing CI contract: $value" >&2
        exit 1
    }
}

require "validate-naming-rules.sh"
require "actionlint"
require "shellcheck"
require "actions/setup-node@v4"
require "node-version: 24"
require "npm run typecheck"
require "npm test"
require "test-governance-contract.sh"
require "test-change-record.sh"
require "test-pr-repository.sh"
require "test-context-detection.sh"
require "test-plan-resolution.sh"
require "test-pr-policy.sh"
require "test-pr-boundary.sh"
require "test-review-comparison.sh"
require "test-ci-evidence.sh"
require "test-merge-policy.sh"
require "test-source-policy.sh"
require "test-deploy-contract.sh"
require "test-release-contract.sh"
require "test-work-metrics.sh"
require "validate-merge"

echo "CI contract tests passed."
