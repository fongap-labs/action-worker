#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/policy.json" <<'JSON'
{
  "runtime": {
    "queue_poll_seconds": 5,
    "queue_wait_minutes": 1
  }
}
JSON

cat > "$TMP/gh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
count_file="${GH_MOCK_COUNT_FILE:?}"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
echo "$count" > "$count_file"

if [ "${GH_MOCK_SCENARIO:-normal}" = "rerun" ]; then
  if [ "$count" -eq 1 ]; then
    printf '%s\n' '{"workflow_runs":[{"id":20,"run_attempt":2,"status":"in_progress","run_started_at":"2026-09-19T02:20:00Z"},{"id":50,"run_attempt":1,"status":"in_progress","run_started_at":"2026-09-19T02:10:00Z"}]}'
  else
    printf '%s\n' '{"workflow_runs":[{"id":20,"run_attempt":2,"status":"in_progress","run_started_at":"2026-09-19T02:20:00Z"}]}'
  fi
elif [ "$count" -eq 1 ]; then
  printf '%s\n' '{"workflow_runs":[{"id":50,"status":"in_progress","run_started_at":"2026-09-19T02:00:00Z"},{"id":100,"status":"in_progress","run_started_at":"2026-09-19T02:01:00Z"},{"id":200,"status":"in_progress","run_started_at":"2026-09-19T02:02:00Z"}]}'
elif [ "$count" -eq 2 ]; then
  printf '%s\n' '{"workflow_runs":[{"id":100,"status":"in_progress","run_started_at":"2026-09-19T02:01:00Z"},{"id":200,"status":"in_progress","run_started_at":"2026-09-19T02:02:00Z"}]}'
else
  printf '%s\n' '{"workflow_runs":[{"id":200,"status":"in_progress","run_started_at":"2026-09-19T02:02:00Z"}]}'
fi
SH
chmod +x "$TMP/gh"

export PATH="$TMP:$PATH"
export GH_TOKEN=test-token
export GH_MOCK_COUNT_FILE="$TMP/count"

sleep() { :; }
export -f sleep

output="$(bash "$ROOT/scripts/wait-review-turn.sh" fongap/action-worker handle-pr-dispatch.yml 200 "$TMP/policy.json" 2>&1)"
grep -F "AI Review queue waiting: run=200 owner=50" <<< "$output" >/dev/null
grep -F "AI Review queue waiting: run=200 owner=100" <<< "$output" >/dev/null
grep -F "AI Review queue turn acquired: run=200" <<< "$output" >/dev/null

rm -f "$GH_MOCK_COUNT_FILE"
export GH_MOCK_SCENARIO=rerun
output="$(bash "$ROOT/scripts/wait-review-turn.sh" fongap/action-worker handle-pr-dispatch.yml 20 "$TMP/policy.json" 2>&1)"
grep -F "AI Review queue waiting: run=20 owner=50" <<< "$output" >/dev/null
grep -F "AI Review queue turn acquired: run=20" <<< "$output" >/dev/null

echo "AI review queue tests passed"
