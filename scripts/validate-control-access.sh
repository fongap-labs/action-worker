#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
    echo "用法：validate-control-access.sh <repository> <pr-number>" >&2
    exit 64
fi

repository="$1"
pr_number="$2"

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "::error::控制目标仓库格式无效。" >&2
    exit 65
}
[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || {
    echo "::error::控制目标 PR 编号无效。" >&2
    exit 65
}

pr_json="$(gh api "repos/$repository/pulls/$pr_number")" || {
    echo "::error::GH_CONTROL_TOKEN 无法读取目标 PR；需要 Pull Requests Read。" >&2
    exit 1
}

head_sha="$(jq -r '.head.sha // empty' <<< "$pr_json")"
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "::error::无法从目标 PR 解析 head SHA。" >&2
    exit 65
}

gh api "repos/$repository/actions/runs?per_page=1" >/dev/null || {
    echo "::error::GH_CONTROL_TOKEN 无法读取目标 Actions；需要 Actions Read。" >&2
    exit 1
}

gh api "repos/$repository/commits/$head_sha/status" >/dev/null || {
    echo "::error::GH_CONTROL_TOKEN 无法读取目标 Commit Status；需要 Commit Statuses Read/Write。" >&2
    exit 1
}

printf 'repository=%s\npr_number=%s\nhead_sha=%s\n' "$repository" "$pr_number" "$head_sha"
