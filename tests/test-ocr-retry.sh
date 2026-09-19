#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/result.json" <<'JSON'
{
  "status": "failed",
  "retry_report": {
    "schema_version": "ocr.llm-retry-report/v1",
    "total_requests": 2,
    "retried_requests": 1,
    "total_retries": 1,
    "recovered_requests": 0,
    "failed_requests": 1,
    "cancelled_requests": 0,
    "requests": [
      {
        "provider": "",
        "model": "Code-Ultra",
        "file_path": "src/example.py",
        "task_type": "main_task",
        "request_no": 1,
        "outcome": "failed",
        "attempts": [
          {
            "attempt": 1,
            "outcome": "error",
            "error_class": "rate_limited",
            "failure_phase": "http",
            "status_code": 429,
            "retry_after_ms": 1500,
            "duration_to_headers_ms": 250
          },
          {
            "attempt": 2,
            "outcome": "success",
            "observed_backoff_ms": 1600,
            "duration_to_headers_ms": 300
          }
        ]
      }
    ]
  }
}
JSON

output="$(bash "$ROOT/scripts/report-ocr-retry.sh" "$TMP/result.json" 2>&1)"

grep -F 'OCR retry summary: total_requests=2 retried_requests=1 total_retries=1 recovered_requests=0 failed_requests=1 cancelled_requests=0' <<< "$output" >/dev/null
grep -F 'status=429 class=rate_limited phase=http retry_after_ms=1500' <<< "$output" >/dev/null

if grep -F 'request_id=' <<< "$output" >/dev/null; then
  echo "ERROR: retry diagnostics must not emit provider request IDs." >&2
  exit 1
fi

printf '{"status":"failed"}\n' > "$TMP/no-report.json"
[ -z "$(bash "$ROOT/scripts/report-ocr-retry.sh" "$TMP/no-report.json" 2>&1)" ]

echo "OCR retry diagnostics tests passed."
