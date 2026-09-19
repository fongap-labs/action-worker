#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 1 ]; then
    echo "用法：validate-review-result.sh <result-json>" >&2
    exit 64
fi

result_file="$1"

[ -f "$result_file" ] || {
    echo "ERROR: OpenCodeReview 结果文件不存在：$result_file" >&2
    exit 65
}

jq -e '
    type == "object"
    and ((.comments // []) | type == "array")
    and (
        if ((.manifest? // null) | type) == "object" and (.manifest.terminal_state? != null)
        then .manifest.terminal_state == "complete"
        else (.status == "complete" or .status == "success")
        end
    )
' "$result_file" >/dev/null || {
    status="$(jq -r '.status // "missing"' "$result_file" 2>/dev/null || echo invalid)"
    terminal_state="$(jq -r '.manifest.terminal_state // "missing"' "$result_file" 2>/dev/null || echo invalid)"
    echo "ERROR: OpenCodeReview 结果不可作为完整审查：status=$status terminal_state=$terminal_state" >&2
    exit 65
}
