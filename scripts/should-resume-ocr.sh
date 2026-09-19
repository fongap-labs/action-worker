#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: should-resume-ocr.sh <ocr-result.json>" >&2
  exit 64
fi

result_path="$1"
[ -f "$result_path" ] || exit 1

jq -e '
  .status == "failed"
  and ((.session_id // "") | length > 0)
  and .retry_report.schema_version == "ocr.llm-retry-report/v1"
  and (
    [(.retry_report.requests // [])[] | select(.outcome == "failed")]
    | length
  ) > 0
  and (
    [(.retry_report.requests // [])[]
      | select(.outcome == "failed")
      | (.attempts // [])[-1]
      | select(
          .outcome == "error"
          and (
            .error_class == "timeout"
            or .error_class == "network"
            or .error_class == "overloaded"
            or (((.status_code // 0) >= 500) and ((.status_code // 0) <= 599))
          )
        )
    ] | length
  ) == (
    [(.retry_report.requests // [])[] | select(.outcome == "failed")]
    | length
  )
' "$result_path" >/dev/null
