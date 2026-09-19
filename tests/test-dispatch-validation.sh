#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VALIDATOR="$SCRIPT_DIR/../scripts/validate-dispatch-payload.sh"
GOOD_SHA="0123456789abcdef0123456789abcdef01234567"

PASSED=0
FAILED=0

if [ ! -f "$VALIDATOR" ]; then
    echo "ERROR: 找不到校验脚本：$VALIDATOR" >&2
    exit 1
fi

check() {
    local name="$1"
    local payload="$2"
    local expected="$3"
    local actual=0

    bash "$VALIDATOR" "$payload" >/dev/null 2>&1 || actual=$?

    if [ "$actual" -eq "$expected" ]; then
        printf 'PASS  %s\n' "$name"
        PASSED=$((PASSED + 1))
    else
        printf 'FAIL  %s（期望=%s，实际=%s）\n' \
            "$name" "$expected" "$actual" >&2
        FAILED=$((FAILED + 1))
    fi
}

check "合法 payload" \
    "{\"schema_version\":\"1\",\"request_id\":\"req-001\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\"}" \
    0

check "非法 JSON" "not json" 64
check "payload 不是对象" "[]" 64
check "缺少 request_id" \
    "{\"schema_version\":\"1\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "request_id 类型错误" \
    "{\"schema_version\":\"1\",\"request_id\":1,\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "schema_version 为空" \
    "{\"schema_version\":\"\",\"request_id\":\"req-001\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "schema_version 不支持" \
    "{\"schema_version\":\"2\",\"request_id\":\"req-001\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 65
check "request_id 含斜杠" \
    "{\"schema_version\":\"1\",\"request_id\":\"req/001\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "request_id 超长" \
    "{\"schema_version\":\"1\",\"request_id\":\"$(printf 'a%.0s' {1..129})\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "project 含斜杠" \
    "{\"schema_version\":\"1\",\"request_id\":\"req-001\",\"project\":\"foo/bar\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "project 非法开头" \
    "{\"schema_version\":\"1\",\"request_id\":\"req-001\",\"project\":\".project\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "project 超长" \
    "{\"schema_version\":\"1\",\"request_id\":\"req-001\",\"project\":\"$(printf 'a%.0s' {1..65})\",\"bootstrap_ref\":\"$GOOD_SHA\"}" 64
check "bootstrap_ref 使用分支名" \
    "{\"schema_version\":\"1\",\"request_id\":\"req-001\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"main\"}" 64
check "bootstrap_ref 不是 hex" \
    "{\"schema_version\":\"1\",\"request_id\":\"req-001\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\"}" 64
check "包含未知字段" \
    "{\"schema_version\":\"1\",\"request_id\":\"req-001\",\"project\":\"FongapBlog\",\"bootstrap_ref\":\"$GOOD_SHA\",\"command\":\"echo test\"}" 64

printf '\nResult: passed=%s failed=%s\n' "$PASSED" "$FAILED"

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi
