#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 8 ]; then
    echo "用法：resolve-pr-plan.sh <context-json> <naming-mode> <review-mode> <block-severity> <review-effort> <review-model> <review-agent> <policy-dir>" >&2
    exit 64
fi

context_json="$1"
naming_mode="$2"
review_mode="$3"
block_override="$4"
effort_override="$5"
model_override="$6"
agent_override="$7"
policy_dir="$8"

naming_policy="$policy_dir/naming.json"
checks_policy="$policy_dir/checks.json"
tests_policy="$policy_dir/tests.json"
review_policy="$policy_dir/review.json"
triage_policy="$policy_dir/triage.json"
execution_policy="$policy_dir/execution.json"

for policy in "$naming_policy" "$checks_policy" "$tests_policy" "$review_policy" "$triage_policy" "$execution_policy"; do
    [ -f "$policy" ] || {
        echo "::error::缺少 PR policy：$policy。" >&2
        exit 65
    }
done

jq -e '
    type == "object"
    and (.project_types | type == "array")
    and (.change_areas | type == "array")
    and (.declared_impacts | type == "array")
    and (.risk | IN("low","medium","high"))
' <<< "$context_json" >/dev/null || {
    echo "::error::PR context 格式无效。" >&2
    exit 65
}


checks="$(
    jq -n         --argjson context "$context_json"         --slurpfile policy "$checks_policy" '
        (
          $policy[0].always
          + [
              $context.change_areas[] as $type
              | ($policy[0].by_change_area[$type] // [])[]
            ]
          + [
              $context.declared_impacts[] as $impact
              | ($policy[0].by_impact[$impact] // [])[]
            ]
        ) | unique
    '
)"

run_project_tests="$(
    jq -n         --argjson context "$context_json"         --slurpfile policy "$tests_policy" '
        (
          ([
            $context.change_areas[] as $type
            | select(($policy[0].trigger_change_areas | index($type)) != null)
          ] | length > 0)
          or
          ([
            $context.declared_impacts[] as $impact
            | select(($policy[0].full_impacts | index($impact)) != null)
          ] | length > 0)
        )
    '
)"

tests='[]'
if [ "$run_project_tests" = "true" ]; then
    tests="$(
        jq -n             --argjson context "$context_json"             --slurpfile policy "$tests_policy" '
            [
              $context.project_types[] as $project
              | ($policy[0].by_project_type[$project] // [])[]
            ] | unique
        '
    )"
fi

impact_tests="$(
    jq -n         --argjson context "$context_json"         --slurpfile policy "$tests_policy" '
        [
          $context.declared_impacts[] as $impact
          | ($policy[0].impact_tests[$impact] // [])[]
        ] | unique
    '
)"

tests="$(jq -cn --argjson a "$tests" --argjson b "$impact_tests" '$a + $b | unique')"

ci_required="$(
    jq -n --argjson context "$context_json" --slurpfile policy "$execution_policy" '
        (
          [$context.change_areas[] as $area
            | select(($policy[0].ci.required_change_areas | index($area)) != null)
            | $area]
          | length > 0
        )
        or
        (
          [$context.declared_impacts[] as $impact
            | select(($policy[0].ci.required_impacts | index($impact)) != null)
            | $impact]
          | length > 0
        )
    '
)"

naming_required="$(jq -r '.always' "$naming_policy")"

has_area() {
    jq -e --arg value "$1" '.change_areas | index($value) != null' <<< "$context_json" >/dev/null
}

has_impact() {
    jq -e --arg value "$1" '.declared_impacts | index($value) != null' <<< "$context_json" >/dev/null
}

review_agent=none

if has_area security || has_impact security; then
    review_agent=security
elif has_impact breaking || has_impact migration || has_impact api || has_impact deployment || has_impact compatibility; then
    review_agent=architecture
elif has_area workflow; then
    review_agent=workflow
elif has_area release || has_impact release; then
    review_agent=release
elif has_area source || has_area script || has_area container; then
    review_agent=code
fi

case "$agent_override" in
    auto) ;;
    none|code|workflow|security|architecture|release)
        review_agent="$agent_override"
        ;;
    *)
        echo "::error::review_agent 仅支持 auto/none/code/workflow/security/architecture/release。" >&2
        exit 64
        ;;
esac

review_required=false
if [ "$review_agent" != "none" ]; then
    review_required=true
fi

case "$review_mode" in
    inherit) ;;
    on)
        review_required=true
        if [ "$review_agent" = "none" ]; then
            review_agent=code
        fi
        ;;
    off)
        review_required=false
        review_agent=none
        ;;
    *)
        echo "::error::review_mode 仅支持 inherit/on/off。" >&2
        exit 64
        ;;
esac

risk="$(jq -r '.risk' <<< "$context_json")"
case "$risk" in
    high)
        block_severity=high
        route_severity=low
        ;;
    medium)
        block_severity=critical
        route_severity=low
        ;;
    low)
        block_severity=none
        route_severity=medium
        ;;
esac

review_model=""
review_effort=low
review_rule=""
review_llm_timeout=0
review_task_timeout=0
review_concurrency=0
triage_required=false
triage_model=""
triage_timeout=0

if [ "$review_agent" != "none" ]; then
    review_model="$(jq -r --arg agent "$review_agent" '.agents[$agent].model // empty' "$review_policy")"
    review_effort="$(jq -r --arg agent "$review_agent" '.agents[$agent].effort // "medium"' "$review_policy")"
    review_rule="$(jq -r --arg agent "$review_agent" '.agents[$agent].rule // empty' "$review_policy")"
    review_llm_timeout="$(jq -r '.runtime.llm_timeout_seconds // 300' "$review_policy")"
    review_task_timeout="$(jq -r '.runtime.task_timeout_minutes // 2' "$review_policy")"
    review_concurrency="$(jq -r '.runtime.concurrency // 1' "$review_policy")"

    if jq -e --arg agent "$review_agent" '.enabled_agents | index($agent) != null' "$triage_policy" >/dev/null; then
        triage_required=true
        triage_model="$(jq -r '.model // empty' "$triage_policy")"
        triage_timeout="$(jq -r '.timeout_seconds // 60' "$triage_policy")"
    fi
fi

case "$naming_mode" in
    inherit) ;;
    on) naming_required=true ;;
    off) naming_required=false ;;
    *)
        echo "::error::naming_mode 仅支持 inherit/on/off。" >&2
        exit 64
        ;;
esac

case "$block_override" in
    inherit) ;;
    none|critical|high|medium|low) block_severity="$block_override" ;;
    *)
        echo "::error::block_severity 无效。" >&2
        exit 64
        ;;
esac

case "$effort_override" in
    inherit) ;;
    low|medium|high) review_effort="$effort_override" ;;
    *)
        echo "::error::review_effort 仅支持 inherit/low/medium/high。" >&2
        exit 64
        ;;
esac

if [ "$model_override" != "auto" ]; then
    review_model="$model_override"
fi

if [ "$review_required" != "true" ]; then
    review_agent=none
    review_model=""
    review_rule=""
    review_llm_timeout=0
    review_task_timeout=0
    review_concurrency=0
    triage_required=false
    triage_model=""
    triage_timeout=0
    block_severity=none
fi

if [ "$review_required" = "true" ]; then
    [[ "$review_llm_timeout" =~ ^[0-9]+$ ]] && [ "$review_llm_timeout" -ge 1 ] && [ "$review_llm_timeout" -le 600 ] || {
        echo "::error::review_llm_timeout 必须为 1-600 秒。" >&2
        exit 65
    }
    [[ "$review_task_timeout" =~ ^[0-9]+$ ]] && [ "$review_task_timeout" -ge 1 ] && [ "$review_task_timeout" -le 30 ] || {
        echo "::error::review_task_timeout 必须为 1-30 分钟。" >&2
        exit 65
    }
    [[ "$review_concurrency" =~ ^[0-9]+$ ]] && [ "$review_concurrency" -ge 1 ] && [ "$review_concurrency" -le 8 ] || {
        echo "::error::review_concurrency 必须为 1-8。" >&2
        exit 65
    }

    [ -n "$review_model" ] || {
        echo "::error::review_model 配置无效。" >&2
        exit 65
    }
fi

if [ "$triage_required" = "true" ]; then
    [ -n "$triage_model" ] || {
        echo "::error::triage_model is invalid." >&2
        exit 65
    }
    [[ "$triage_timeout" =~ ^[0-9]+$ ]] && [ "$triage_timeout" -ge 1 ] && [ "$triage_timeout" -le 300 ] || {
        echo "::error::triage_timeout must be 1-300 seconds." >&2
        exit 65
    }
fi

jq -n     --argjson context "$context_json"     --argjson checks "$checks"     --argjson tests "$tests"     --argjson ci_required "$ci_required"     --argjson naming_required "$naming_required"     --argjson review_required "$review_required"     --arg review_agent "$review_agent"     --arg review_model "$review_model"     --arg review_rule "$review_rule"     --argjson review_llm_timeout "$review_llm_timeout"     --argjson review_task_timeout "$review_task_timeout"     --argjson review_concurrency "$review_concurrency"     --argjson triage_required "$triage_required"     --arg triage_model "$triage_model"     --argjson triage_timeout "$triage_timeout"     --arg block_severity "$block_severity"     --arg review_effort "$review_effort"     --arg route_severity "$route_severity"     '{
      context: $context,
      checks: $checks,
      tests: $tests,
      ci_required: $ci_required,
      naming_required: $naming_required,
      review_required: $review_required,
      review_agent: $review_agent,
      review_model: $review_model,
      review_rule: $review_rule,
      review_llm_timeout: $review_llm_timeout,
      review_task_timeout: $review_task_timeout,
      review_concurrency: $review_concurrency,
      triage_required: $triage_required,
      triage_model: $triage_model,
      triage_timeout: $triage_timeout,
      block_severity: $block_severity,
      review_effort: $review_effort,
      route_severity: $route_severity
    }'
