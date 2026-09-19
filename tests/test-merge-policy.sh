#!/usr/bin/env bash

set -Eeuo pipefail

ACTION=".github/actions/validate-merge-policy/action.yml"

[ -f "$ACTION" ] || {
    echo "ERROR: $ACTION not found." >&2
    exit 1
}

require() {
    local value="$1"
    grep -qF -- "$value" "$ACTION" || {
        echo "ERROR: missing merge policy contract: $value" >&2
        exit 1
    }
}

require "ci-result:"
require "head-sha:"
require "require-pr-governance:"
require "PR Governance"
require "Local CI evidence did not pass"
require 'repos/$GITHUB_REPOSITORY/commits/$HEAD_SHA/status'
require "PR Governance blocked merge"
require "Timed out waiting for PR Governance"

echo "Merge policy contract tests passed."
