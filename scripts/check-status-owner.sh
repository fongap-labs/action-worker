#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "Usage: check-status-owner.sh <repository> <sha> <run-url> [context]" >&2
    exit 64
fi

repository="$1"
sha="$2"
run_url="$3"
context="${4:-PR Governance}"

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "ERROR: invalid repository: $repository" >&2
    exit 64
}

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: invalid commit SHA." >&2
    exit 64
}

[ -n "$run_url" ] || {
    echo "ERROR: run URL is required." >&2
    exit 64
}

[ -n "${GH_TOKEN:-}" ] || {
    echo "ERROR: GH_TOKEN is required." >&2
    exit 1
}

latest_target="$(
    gh api "repos/$repository/commits/$sha/status" |
        jq -r --arg context "$context" '
          [
            .statuses[]
            | select(.context == $context)
            | {target_url, created_at}
          ]
          | sort_by(.created_at)
          | reverse
          | .[0].target_url // ""
        '
)"

if [ "$latest_target" = "$run_url" ]; then
    echo "Current run still owns $context for $repository@$sha."
    exit 0
fi

echo "Current run no longer owns $context for $repository@$sha; latest target is ${latest_target:-<none>}." >&2
exit 3
