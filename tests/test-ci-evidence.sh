#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAITER="$ROOT/scripts/wait-ci-evidence.sh"
VALIDATOR="$ROOT/scripts/validate-ci-evidence.sh"
POLICY="$ROOT/policies/execution.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${*: -1}"
mode="${MOCK_MODE:-success}"
case "$url" in
  *"/actions/workflows/ci.yml/runs?"*)
    printf '%s\n' '{"workflow_runs":[{"id":123,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-09-19T00:00:00Z"}]}'
    ;;
  *"/actions/runs/123/jobs"*)
    case "$mode" in
      success)
        printf '%s\n' '{"jobs":[{"name":"ci-evidence","status":"completed","conclusion":"success"},{"name":"validate-merge","status":"in_progress","conclusion":null}]}'
        ;;
      gate-fail)
        printf '%s\n' '{"jobs":[{"name":"ci-evidence","status":"completed","conclusion":"failure"},{"name":"validate-merge","status":"in_progress","conclusion":null}]}'
        ;;
      legacy)
        printf '%s\n' '{"jobs":[{"name":"validate-merge","status":"completed","conclusion":"success"}]}'
        ;;
      *)
        echo "unexpected mode: $mode" >&2
        exit 2
        ;;
    esac
    ;;
  *"/actions/runs/123")
    if [ "$mode" = "legacy" ]; then
      printf '%s\n' '{"status":"completed","conclusion":"success"}'
    else
      printf '%s\n' '{"status":"in_progress","conclusion":null}'
    fi
    ;;
  *)
    echo "unexpected gh url: $url" >&2
    exit 2
    ;;
esac
GH
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

out="$(MOCK_MODE=success bash "$WAITER" "fongap/example" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$POLICY")"
jq -e '
  .run_id == 123
  and .status == "in_progress"
  and .gate_job == "ci-evidence"
  and .gate_conclusion == "success"
  and (.jobs | length) == 2
' <<< "$out" >/dev/null
printf '%s\n' "$out" > "$TMP/success.json"
bash "$VALIDATOR" "$TMP/success.json" >/dev/null

legacy="$(MOCK_MODE=legacy bash "$WAITER" "fongap/example" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$POLICY")"
jq -e '
  .gate_job == "validate-merge"
  and .gate_conclusion == "success"
' <<< "$legacy" >/dev/null
printf '%s\n' "$legacy" > "$TMP/legacy.json"
bash "$VALIDATOR" "$TMP/legacy.json" >/dev/null

failed="$(MOCK_MODE=gate-fail bash "$WAITER" "fongap/example" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$POLICY")"
jq -e '.gate_job == "ci-evidence" and .gate_conclusion == "failure"' <<< "$failed" >/dev/null
printf '%s\n' "$failed" > "$TMP/failed.json"
if bash "$VALIDATOR" "$TMP/failed.json" >/dev/null 2>&1; then
  echo "ERROR: failed ci-evidence must block governance." >&2
  exit 1
fi

echo "CI evidence tests passed."
