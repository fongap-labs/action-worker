#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
    echo "Usage: wait-review-turn.sh <repository> <workflow-file> <run-id> <policy-file>" >&2
    exit 64
fi

repository="$1"
workflow_file="$2"
run_id="$3"
policy_file="$4"

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "ERROR: invalid repository: $repository" >&2
    exit 65
}
[[ "$run_id" =~ ^[0-9]+$ ]] || {
    echo "ERROR: invalid run id." >&2
    exit 65
}
[ -f "$policy_file" ] || {
    echo "ERROR: review policy not found: $policy_file" >&2
    exit 65
}
[ -n "${GH_TOKEN:-}" ] || {
    echo "ERROR: GH_TOKEN is required." >&2
    exit 1
}

poll_seconds="$(jq -r '.runtime.queue_poll_seconds // 15' "$policy_file")"
wait_minutes="$(jq -r '.runtime.queue_wait_minutes // 120' "$policy_file")"

[[ "$poll_seconds" =~ ^[0-9]+$ ]] && [ "$poll_seconds" -ge 5 ] && [ "$poll_seconds" -le 300 ] || {
    echo "ERROR: queue_poll_seconds must be 5-300." >&2
    exit 65
}
[[ "$wait_minutes" =~ ^[0-9]+$ ]] && [ "$wait_minutes" -ge 1 ] && [ "$wait_minutes" -le 360 ] || {
    echo "ERROR: queue_wait_minutes must be 1-360." >&2
    exit 65
}

deadline=$((SECONDS + wait_minutes * 60))
last_owner=""

while true; do
    runs_json="$(gh api "repos/$repository/actions/workflows/$workflow_file/runs?per_page=100")"
    owner="$(
        jq -r '
          [
            (.workflow_runs // [])[]
            | select(.status == "queued" or .status == "in_progress")
            | {
                id,
                started_at: (.run_started_at // .created_at // "")
              }
          ]
          | sort_by(.started_at, .id)
          | if length == 0 then empty else .[0].id end
        ' <<< "$runs_json"
    )"

    if [ -z "$owner" ] || [ "$owner" = "$run_id" ]; then
        echo "AI Review queue turn acquired: run=$run_id"
        exit 0
    fi

    if [ "$owner" != "$last_owner" ]; then
        echo "AI Review queue waiting: run=$run_id owner=$owner" >&2
        last_owner="$owner"
    fi

    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "ERROR: AI Review queue wait exceeded ${wait_minutes} minute(s)." >&2
        exit 1
    fi

    sleep "$poll_seconds"
done
