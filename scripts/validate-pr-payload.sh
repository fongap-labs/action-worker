#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 1 ]; then
    echo "用法：validate-pr-payload.sh <payload-json>" >&2
    exit 64
fi

payload="$1"

jq -e '
    type == "object"
    and (keys | sort == ["pr_number","repository","request_id","schema_version"])
    and .schema_version == "1"
    and (.request_id | type == "string")
    and (.request_id | length >= 1 and length <= 128)
    and (.request_id | test("^[A-Za-z0-9._:-]+$"))
    and (.repository | type == "string")
    and (.repository | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
    and (.pr_number | type == "number")
    and (.pr_number | floor == .)
    and (.pr_number >= 1)
' <<< "$payload" >/dev/null || {
    echo "::error::PR dispatch payload 不符合 contracts/pr-task.json。" >&2
    exit 64
}

echo "PR dispatch payload validated."
