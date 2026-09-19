#!/usr/bin/env bash

set -u

WORKFLOW=".github/workflows/handle-task-dispatch.yml"

if [ ! -f "$WORKFLOW" ]; then
    echo "ERROR: $WORKFLOW not found." >&2
    exit 1
fi

PASSED=0
FAILED=0

pass() {
    printf 'PASS  %s\n' "$1"
    PASSED=$((PASSED + 1))
}

fail() {
    printf 'FAIL  %s（%s）\n' "$1" "$2" >&2
    FAILED=$((FAILED + 1))
}

require_literal() {
    local name="$1"
    local value="$2"
    if grep -qF "$value" "$WORKFLOW"; then
        pass "$name"
    else
        fail "$name" "未找到：$value"
    fi
}

forbid_regex() {
    local name="$1"
    local pattern="$2"
    if grep -qE "$pattern" "$WORKFLOW"; then
        fail "$name" "发现禁止模式"
    else
        pass "$name"
    fi
}

forbid_regex "不存在 toJSON(secrets)" 'toJSON\s*\(\s*secrets\s*\)'
require_literal "Execute task 使用通用 secrets 环境" 'env: ${{ secrets }}'
require_literal "Repository Variables 使用通用 vars 通道" 'REPOSITORY_VARS_JSON: ${{ toJSON(vars) }}'
require_literal "Repository Variables 在快照前导入" 'bash scripts/export-repository-variables.sh'
require_literal "执行前检查变量冲突" 'bash scripts/validate-repository-variables.sh'
forbid_regex "不直接引用任何命名 Secret" '\$\{\{[[:space:]]*secrets\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\}\}'
forbid_regex "不存在动态 environment.name" '^[[:space:]]*environment:[[:space:]]*$'
require_literal "存在基础环境快照" '快照基础环境'
require_literal "基础环境快照只保存变量名" 'compgen -e'
require_literal "cleanup 删除基础环境快照" 'action-worker-base-env.names'
require_literal "cleanup 删除 Variables 快照" 'action-worker-repository-vars.json'
forbid_regex "不存在 set -x / printenv / shell 裸 env" 'set[[:space:]]+-x|printenv|^[[:space:]]*env[[:space:]]*$'
require_literal "payload 使用显式 dispatch 校验器" 'validate-dispatch-payload.sh'

printf '\nResult: passed=%s failed=%s\n' "$PASSED" "$FAILED"

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi
