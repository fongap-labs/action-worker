#!/usr/bin/env bash

set -Eeuo pipefail

WORKFLOW=".github/workflows/validate-source-policy.yml"

[ -f "$WORKFLOW" ] || {
    echo "ERROR: $WORKFLOW not found." >&2
    exit 1
}

require() {
    local value="$1"
    grep -qF -- "$value" "$WORKFLOW" || {
        echo "ERROR: missing source policy contract: $value" >&2
        exit 1
    }
}

require "workflow_call:"
require "contents: read"
require "actions: read"
require "target_sha:"
require "ci_workflow:"
require "require_default_head:"
require "40 位 Commit SHA"
require "default_branch"
require "gh run list"
require "databaseId"
require "未找到目标 Commit 的成功 CI"
require 'target_sha=$resolved_sha'
require 'ci_run_id=$ci_run_id'

echo "Source policy contract tests passed."
