#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
    echo "Usage: apply-ai-triage.sh <base-plan-file> <triage-result-file> <triage-policy-file> <review-policy-file>" >&2
    exit 64
fi

base_plan_file="$1"
triage_result_file="$2"
triage_policy_file="$3"
review_policy_file="$4"

for path in "$base_plan_file" "$triage_policy_file" "$review_policy_file"; do
    [ -f "$path" ] || {
        echo "ERROR: required file not found: $path" >&2
        exit 65
    }
done

base_plan="$(cat "$base_plan_file")"
if [ -f "$triage_result_file" ]; then
    triage_result="$(cat "$triage_result_file")"
else
    triage_result='{"status":"skipped","reason":"not_run"}'
fi

jq -e '
  type == "object"
  and (.review_required | type == "boolean")
  and (.review_agent | type == "string")
  and (.context.change_areas | type == "array")
  and (.context.declared_impacts | type == "array")
' <<< "$base_plan" >/dev/null || {
    echo "ERROR: invalid base plan." >&2
    exit 65
}

min_skip_confidence="$(jq -r '.min_skip_confidence' "$triage_policy_file")"
min_deep_confidence="$(jq -r '.min_deep_confidence' "$triage_policy_file")"
deep_model="$(jq -r '.deep_model' "$triage_policy_file")"

for value in "$min_skip_confidence" "$min_deep_confidence"; do
    awk -v n="$value" 'BEGIN { exit !(n >= 0 && n <= 1) }' || {
        echo "ERROR: invalid triage confidence policy." >&2
        exit 65
    }
done

final_plan="$base_plan"
triage_status="$(jq -r '.status // "unavailable"' <<< "$triage_result" 2>/dev/null || echo unavailable)"
action=keep

if [ "$triage_status" = "complete" ]; then
    if ! jq -e '
      (.decision.review_required | type == "boolean")
      and (.decision.review_agent | IN("code","workflow","release","security","architecture"))
      and (.decision.risk | IN("low","medium","high"))
      and (.decision.depth | IN("normal","deep"))
      and (.decision.confidence | type == "number")
      and (.decision.confidence >= 0 and .decision.confidence <= 1)
    ' <<< "$triage_result" >/dev/null 2>&1; then
        triage_status=unavailable
    fi
fi

if [ "$triage_status" = "complete" ] && [ "$(jq -r '.review_required' <<< "$base_plan")" = "true" ]; then
    base_agent="$(jq -r '.review_agent' <<< "$base_plan")"
    decision_agent="$(jq -r '.decision.review_agent' <<< "$triage_result")"
    decision_required="$(jq -r '.decision.review_required' <<< "$triage_result")"
    decision_risk="$(jq -r '.decision.risk' <<< "$triage_result")"
    decision_depth="$(jq -r '.decision.depth' <<< "$triage_result")"
    confidence="$(jq -r '.decision.confidence' <<< "$triage_result")"

    safe_skip_surface="$(jq -r '
      (.context.change_areas | length) > 0
      and ([.context.change_areas[] | select(. != "source" and . != "test")] | length == 0)
      and (.context.declared_impacts | length == 0)
    ' <<< "$base_plan")"

    can_skip=false
    if [ "$base_agent" = "code" ]       && [ "$safe_skip_surface" = "true" ]       && [ "$decision_required" = "false" ]       && [ "$decision_risk" = "low" ]       && awk -v n="$confidence" -v m="$min_skip_confidence" 'BEGIN { exit !(n >= m) }'; then
        can_skip=true
    fi

    if [ "$can_skip" = "true" ]; then
        final_plan="$(jq '
          .review_required = false
          | .review_agent = "none"
          | .review_model = ""
          | .review_rule = ""
          | .review_llm_timeout = 0
          | .review_task_timeout = 0
          | .review_concurrency = 0
          | .review_effort = "low"
          | .block_severity = "none"
        ' <<< "$final_plan")"
        action=skip
    else
        selected_agent="$base_agent"

        case "$decision_agent" in
            security|architecture)
                selected_agent="$decision_agent"
                ;;
            workflow|release)
                if [ "$base_agent" = "code" ]; then
                    selected_agent="$decision_agent"
                fi
                ;;
        esac

        if [ "$selected_agent" != "$base_agent" ]; then
            selected_model="$(jq -r --arg agent "$selected_agent" '.agents[$agent].model // empty' "$review_policy_file")"
            selected_effort="$(jq -r --arg agent "$selected_agent" '.agents[$agent].effort // empty' "$review_policy_file")"
            selected_rule="$(jq -r --arg agent "$selected_agent" '.agents[$agent].rule // empty' "$review_policy_file")"

            [ -n "$selected_model" ] && [ -n "$selected_effort" ] && [ -n "$selected_rule" ] || {
                echo "ERROR: triage selected an unconfigured review agent." >&2
                exit 65
            }

            final_plan="$(jq \
              --arg agent "$selected_agent" \
              --arg model "$selected_model" \
              --arg effort "$selected_effort" \
              --arg rule "$selected_rule" '
                .review_agent = $agent
                | .review_model = $model
                | .review_effort = $effort
                | .review_rule = $rule
              ' <<< "$final_plan")"
            action=upgrade
        fi

        if [ "$decision_agent" = "security" ] || [ "$decision_agent" = "architecture" ] || [ "$decision_risk" = "high" ]; then
            current_threshold="$(jq -r '.block_severity' <<< "$final_plan")"
            if [ "$current_threshold" = "none" ] || [ "$current_threshold" = "critical" ]; then
                final_plan="$(jq '.block_severity = "high"' <<< "$final_plan")"
            fi
        fi

        if { [ "$decision_depth" = "deep" ] || [ "$decision_risk" = "high" ]; } \
          && awk -v n="$confidence" -v m="$min_deep_confidence" 'BEGIN { exit !(n >= m) }'; then
            final_plan="$(jq \
              --arg model "$deep_model" '
                .review_model = $model
                | .review_effort = "high"
              ' <<< "$final_plan")"
            if [ "$action" = "keep" ]; then
                action=deepen
            fi
        fi
    fi
fi

final_plan="$(jq \
  --arg status "$triage_status" \
  --arg action "$action" \
  --argjson triage "$triage_result" '
    .triage = {
      status: $status,
      action: $action,
      result: $triage
    }
  ' <<< "$final_plan")"

jq -c . <<< "$final_plan"
