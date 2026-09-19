#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "用法：set-pr-status.sh <repository> <sha> <state> <description> [target-url]" >&2
    exit 64
fi

repository="$1"
sha="$2"
state="$3"
description="$4"
target_url="${5:-}"
context="${PR_STATUS_CONTEXT:-PR Governance}"

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "::error::repository 格式无效：$repository。" >&2
    exit 64
}

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "::error::commit SHA 无效。" >&2
    exit 64
}

case "$state" in
    pending|success|failure|error) ;;
    *)
        echo "::error::commit status state 无效：$state。" >&2
        exit 64
        ;;
esac

[ -n "${GH_TOKEN:-}" ] || {
    echo "::error::缺少 GH_TOKEN。" >&2
    exit 1
}

args=(
    --method POST
    "repos/$repository/statuses/$sha"
    -f "state=$state"
    -f "context=$context"
    -f "description=$description"
)

if [ -n "$target_url" ]; then
    args+=(-f "target_url=$target_url")
fi

gh api "${args[@]}" >/dev/null
echo "PR status updated: $repository@$sha $context=$state"
