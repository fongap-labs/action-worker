#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 1 ]; then
    echo "用法：validate-ci-evidence.sh <evidence-json>" >&2
    exit 64
fi

evidence_file="$1"

[ -f "$evidence_file" ] || {
    echo "::error::缺少 CI Evidence：$evidence_file" >&2
    exit 65
}

jq -e '
  type == "object"
  and (.repository | type == "string" and length > 0)
  and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.workflow | type == "string" and length > 0)
  and (.gate_job | type == "string" and length > 0)
  and (.run_id | type == "number")
  and (.jobs | type == "array")
' "$evidence_file" >/dev/null || {
    echo "::error::CI Evidence 格式无效。" >&2
    exit 65
}

conclusion="$(jq -r '.conclusion // "missing"' "$evidence_file")"
gate_conclusion="$(jq -r '.gate_conclusion // "missing"' "$evidence_file")"
run_id="$(jq -r '.run_id' "$evidence_file")"
gate_job="$(jq -r '.gate_job' "$evidence_file")"

[ "$gate_conclusion" = "success" ] || {
    echo "::error::业务仓 CI 缺少成功的 $gate_job：run=$run_id conclusion=$gate_conclusion" >&2
    exit 1
}

echo "CI evidence passed: run=$run_id gate=$gate_job workflow=$conclusion"
