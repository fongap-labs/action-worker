#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/should-resume-ocr.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

write_case() {
  local path="$1"
  local status="$2"
  local session_id="$3"
  local request_outcome="$4"
  local error_class="$5"
  local status_code="$6"

  jq -n     --arg status "$status"     --arg session_id "$session_id"     --arg request_outcome "$request_outcome"     --arg error_class "$error_class"     --argjson status_code "$status_code"     '{
      status: $status,
      session_id: $session_id,
      retry_report: {
        schema_version: "ocr.llm-retry-report/v1",
        requests: [
          {
            outcome: $request_outcome,
            attempts: [
              {
                outcome: "error",
                error_class: $error_class,
                status_code: $status_code
              }
            ]
          }
        ]
      }
    }' > "$path"
}

write_case "$TMP/timeout.json" failed session-1 failed timeout 504
bash "$CHECK" "$TMP/timeout.json"

write_case "$TMP/provider-503.json" failed session-2 failed provider 503
bash "$CHECK" "$TMP/provider-503.json"

write_case "$TMP/auth.json" failed session-3 failed authentication 401
if bash "$CHECK" "$TMP/auth.json"; then
  echo "ERROR: authentication failure must not resume." >&2
  exit 1
fi

write_case "$TMP/client-400.json" failed session-4 failed provider 400
if bash "$CHECK" "$TMP/client-400.json"; then
  echo "ERROR: client error must not resume." >&2
  exit 1
fi

write_case "$TMP/complete.json" complete session-5 recovered timeout 504
if bash "$CHECK" "$TMP/complete.json"; then
  echo "ERROR: completed review must not resume." >&2
  exit 1
fi

write_case "$TMP/no-session.json" failed "" failed timeout 504
if bash "$CHECK" "$TMP/no-session.json"; then
  echo "ERROR: review without session id must not resume." >&2
  exit 1
fi

cat > "$TMP/mixed.json" <<'JSON'
{
  "status": "failed",
  "session_id": "session-6",
  "retry_report": {
    "schema_version": "ocr.llm-retry-report/v1",
    "requests": [
      {
        "outcome": "failed",
        "attempts": [
          {
            "outcome": "error",
            "error_class": "timeout",
            "status_code": 504
          }
        ]
      },
      {
        "outcome": "failed",
        "attempts": [
          {
            "outcome": "error",
            "error_class": "authentication",
            "status_code": 401
          }
        ]
      }
    ]
  }
}
JSON

if bash "$CHECK" "$TMP/mixed.json"; then
  echo "ERROR: mixed transient and permanent failures must not resume." >&2
  exit 1
fi

echo "OCR resume policy tests passed."
