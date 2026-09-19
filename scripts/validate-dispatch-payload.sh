#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

if [ "$#" -ne 1 ]; then
    echo "::error::参数错误：请传入 repository_dispatch 的 client_payload JSON。" >&2
    exit 64
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "::error::运行环境缺少 jq，无法校验任务参数。" >&2
    exit 1
fi

PAYLOAD="$1"
SUPPORTED_SCHEMA_VERSIONS=("1")

if ! printf '%s' "$PAYLOAD" | jq -e . >/dev/null 2>&1; then
    echo "::error::请求格式错误：client_payload 不是合法 JSON。" >&2
    exit 64
fi

if ! printf '%s' "$PAYLOAD" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "::error::请求格式错误：client_payload 必须是 JSON 对象。" >&2
    exit 64
fi

missing=$(printf '%s' "$PAYLOAD" | jq -r '
    . as $obj |
    ["schema_version","request_id","project","bootstrap_ref"] |
    map(. as $key | select(($obj | has($key)) | not)) |
    join(", ")
')

if [ -n "$missing" ]; then
    echo "::error::请求缺少必要字段：${missing}。" >&2
    exit 64
fi

invalid_types=$(printf '%s' "$PAYLOAD" | jq -r '
    . as $obj |
    ["schema_version","request_id","project","bootstrap_ref"] |
    map(. as $key | select(($obj[$key] | type) != "string")) |
    join(", ")
')

if [ -n "$invalid_types" ]; then
    echo "::error::字段类型错误：${invalid_types} 必须是字符串。" >&2
    exit 64
fi

empty_fields=$(printf '%s' "$PAYLOAD" | jq -r '
    . as $obj |
    ["schema_version","request_id","project","bootstrap_ref"] |
    map(. as $key | select($obj[$key] == "")) |
    join(", ")
')

if [ -n "$empty_fields" ]; then
    echo "::error::字段不能为空：${empty_fields}。" >&2
    exit 64
fi

schema_version=$(printf '%s' "$PAYLOAD" | jq -r '.schema_version')
request_id=$(printf '%s' "$PAYLOAD" | jq -r '.request_id')
project=$(printf '%s' "$PAYLOAD" | jq -r '.project')
bootstrap_ref=$(printf '%s' "$PAYLOAD" | jq -r '.bootstrap_ref')

supported=0
for version in "${SUPPORTED_SCHEMA_VERSIONS[@]}"; do
    if [ "$version" = "$schema_version" ]; then
        supported=1
        break
    fi
done

if [ "$supported" -ne 1 ]; then
    echo "::error::暂不支持 schema_version=${schema_version}，当前仅支持版本 ${SUPPORTED_SCHEMA_VERSIONS[*]}。" >&2
    exit 65
fi

if ! [[ "$request_id" =~ ^[A-Za-z0-9_.-]{1,128}$ ]]; then
    echo "::error::request_id 格式错误：仅允许字母、数字、点、下划线和横线，最长 128 个字符。" >&2
    exit 64
fi

if ! [[ "$project" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
    echo "::error::project 格式错误：必须以字母或数字开头，仅允许字母、数字、点、下划线和横线，最长 64 个字符。" >&2
    exit 64
fi

if ! [[ "$bootstrap_ref" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "::error::bootstrap_ref 格式错误：必须使用完整的 40 位 Commit SHA。" >&2
    exit 64
fi

unknown=$(printf '%s' "$PAYLOAD" | jq -r '
    ["schema_version","request_id","project","bootstrap_ref"] as $allowed |
    [keys[] | select(. as $key | $allowed | index($key) | not)] |
    join(", ")
')

if [ -n "$unknown" ]; then
    echo "::error::请求包含不支持的字段：${unknown}。" >&2
    exit 64
fi
