#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 1 ]; then
    echo "用法：validate-pr-repository.sh <repository>" >&2
    exit 64
fi

repository="$1"
allowlist="${PR_REPOSITORY_ALLOWLIST:-}"

fail() {
    echo "::error::$*" >&2
    exit "${2:-65}"
}

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]     || fail "PR repository 格式无效：$repository。" 64

[ -n "$allowlist" ]     || fail "缺少 Repository Variable：PR_REPOSITORY_ALLOWLIST。"

jq -e '
    type == "array"
    and length > 0
    and length == (unique | length)
    and all(.[]; type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
' <<< "$allowlist" >/dev/null     || fail "PR_REPOSITORY_ALLOWLIST 必须是非空、无重复的 repository JSON 数组。"

if ! jq -e --arg repository "$repository" 'index($repository) != null' <<< "$allowlist" >/dev/null; then
    fail "PR repository 不在允许名单：$repository。" 77
fi

echo "PR repository allowed: $repository"
