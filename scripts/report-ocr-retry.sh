#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: report-ocr-retry.sh <ocr-result.json>" >&2
    exit 64
fi

result_path="$1"
[ -f "$result_path" ] || exit 0

schema="$(jq -r '.retry_report.schema_version // empty' "$result_path" 2>/dev/null || true)"
[ "$schema" = "ocr.llm-retry-report/v1" ] || exit 0

jq -r '
  .retry_report as $r
  | "OCR retry summary: total_requests=\($r.total_requests // 0) retried_requests=\($r.retried_requests // 0) total_retries=\($r.total_retries // 0) recovered_requests=\($r.recovered_requests // 0) failed_requests=\($r.failed_requests // 0) cancelled_requests=\($r.cancelled_requests // 0)",
    (
      ($r.requests // [])[]
      | . as $request
      | ($request.attempts // [])[]
      | select(.outcome == "error")
      | "OCR retry attempt: model=\($request.model // "unknown") file=\($request.file_path // "unknown") task=\($request.task_type // "unknown") request_no=\($request.request_no // 0) attempt=\(.attempt // 0) status=\(.status_code // 0) class=\(.error_class // "unknown") phase=\(.failure_phase // "unknown") retry_after_ms=\(.retry_after_ms // 0) backoff_ms=\(.observed_backoff_ms // 0) headers_ms=\(.duration_to_headers_ms // 0)"
    )
' "$result_path" >&2
