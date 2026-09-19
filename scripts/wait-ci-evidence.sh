#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 3 ]; then
    echo "用法：wait-ci-evidence.sh <repository> <head-sha> <policy-file>" >&2
    exit 64
fi

repository="$1"
head_sha="$2"
policy_file="$3"

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "::error::CI repository 格式无效。" >&2
    exit 65
}
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "::error::CI head SHA 格式无效。" >&2
    exit 65
}
[ -f "$policy_file" ] || {
    echo "::error::缺少 CI execution policy：$policy_file" >&2
    exit 65
}

workflow="$(jq -r '.ci.workflow // empty' "$policy_file")"
gate_jobs="$(jq -c '.ci.gate_jobs // []' "$policy_file")"
poll_seconds="$(jq -r '.ci.poll_seconds // 15' "$policy_file")"
timeout_minutes="$(jq -r '.ci.timeout_minutes // 20' "$policy_file")"

[ -n "$workflow" ] || {
    echo "::error::CI evidence policy 缺少 workflow。" >&2
    exit 65
}

jq -e '
  type == "array"
  and length > 0
  and all(.[]; type == "string" and length > 0)
  and (unique | length) == length
' <<< "$gate_jobs" >/dev/null || {
    echo "::error::CI evidence policy gate_jobs 无效。" >&2
    exit 65
}

if ! { [[ "$poll_seconds" =~ ^[0-9]+$ ]] && [ "$poll_seconds" -ge 5 ] && [ "$poll_seconds" -le 120 ]; }; then
    echo "::error::CI poll_seconds 必须为 5-120 秒。" >&2
    exit 65
fi
if ! { [[ "$timeout_minutes" =~ ^[0-9]+$ ]] && [ "$timeout_minutes" -ge 1 ] && [ "$timeout_minutes" -le 60 ]; }; then
    echo "::error::CI timeout_minutes 必须为 1-60 分钟。" >&2
    exit 65
fi

deadline=$(( $(date +%s) + timeout_minutes * 60 ))

while [ "$(date +%s)" -lt "$deadline" ]; do
    response="$(gh api "repos/$repository/actions/workflows/$workflow/runs?event=pull_request&head_sha=$head_sha&per_page=20")"

    run_id="$(jq -r --arg sha "$head_sha" '
        [.workflow_runs[] | select(.head_sha == $sha)]
        | sort_by(.created_at)
        | reverse
        | .[0].id // empty
    ' <<< "$response")"

    if [ -z "$run_id" ]; then
        echo "CI evidence pending: waiting for $repository@$head_sha" >&2
        sleep "$poll_seconds"
        continue
    fi

    run="$(gh api "repos/$repository/actions/runs/$run_id")"
    status="$(jq -r '.status // "unknown"' <<< "$run")"
    conclusion="$(jq -r '.conclusion // "unknown"' <<< "$run")"
    jobs="$(gh api "repos/$repository/actions/runs/$run_id/jobs?per_page=100")"

    selected_gate="$(
      jq -nr --argjson gates "$gate_jobs" --argjson jobs "$jobs" '
        [
          $gates[] as $gate
          | $jobs.jobs[]
          | select(.name == $gate or (.name | endswith(" / " + $gate)))
          | {gate: $gate, status: (.status // "unknown"), conclusion: (.conclusion // "unknown")}
        ]
        | .[0] // empty
        | if . == null then "" else @base64 end
      '
    )"

    if [ -z "$selected_gate" ]; then
        if [ "$status" = "completed" ]; then
            echo "::error::CI workflow 已完成，但未找到支持的 evidence job。" >&2
            exit 65
        fi
        echo "CI evidence pending: run=$run_id no supported evidence job yet" >&2
        sleep "$poll_seconds"
        continue
    fi

    gate_json="$(printf '%s' "$selected_gate" | base64 -d)"
    gate_job="$(jq -r '.gate' <<< "$gate_json")"
    gate_status="$(jq -r '.status' <<< "$gate_json")"
    gate_conclusion="$(jq -r '.conclusion' <<< "$gate_json")"

    if [ "$gate_status" != "completed" ]; then
        echo "CI evidence pending: run=$run_id gate=$gate_job status=$gate_status" >&2
        sleep "$poll_seconds"
        continue
    fi

    job_results="$(jq -c '
      [.jobs[]
        | {
            name: (.name | tostring | .[0:160]),
            status: (.status // "unknown"),
            conclusion: (.conclusion // "unknown")
          }]
    ' <<< "$jobs")"

    jq -n \
      --arg repository "$repository" \
      --arg head_sha "$head_sha" \
      --arg workflow "$workflow" \
      --arg gate_job "$gate_job" \
      --arg status "$status" \
      --arg conclusion "$conclusion" \
      --arg gate_conclusion "$gate_conclusion" \
      --argjson run_id "$run_id" \
      --argjson jobs "$job_results" \
      '{
        repository: $repository,
        head_sha: $head_sha,
        workflow: $workflow,
        gate_job: $gate_job,
        run_id: $run_id,
        status: $status,
        conclusion: $conclusion,
        gate_conclusion: $gate_conclusion,
        jobs: $jobs
      }'
    exit 0
done

echo "::error::等待业务仓 CI 超时：repository=$repository head=$head_sha timeout=${timeout_minutes}m" >&2
exit 1
