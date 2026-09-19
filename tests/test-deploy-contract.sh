#!/usr/bin/env bash

set -Eeuo pipefail

WORKFLOW=".github/workflows/validate-deploy-policy.yml"

[ -f "$WORKFLOW" ] || {
    echo "ERROR: $WORKFLOW not found." >&2
    exit 1
}

require() {
    local value="$1"
    grep -qF -- "$value" "$WORKFLOW" || {
        echo "ERROR: missing deploy contract: $value" >&2
        exit 1
    }
}

require "workflow_call:"
require "contents: read"
require "actions: read"
require "target_sha:"
require "ci_workflow:"
require "require_default_head:"
require 'uses: ./.github/workflows/validate-source-policy.yml'
require 'target_sha: ${{ inputs.target_sha }}'
require 'ci_workflow: ${{ inputs.ci_workflow }}'
require 'require_default_head: ${{ inputs.require_default_head }}'

echo "Deploy policy contract tests passed."
