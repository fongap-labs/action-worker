#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 6 ]; then
    echo "用法：publish-pr-review.sh <repository> <pr-number> <status> <run-url> <plan-file> <result-file>" >&2
    exit 64
fi

repository="$1"
pr_number="$2"
status="$3"
run_url="$4"
plan_file="$5"
result_file="$6"
marker='<!-- action-worker-pr-governance -->'

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "::error::repository 格式无效：$repository。" >&2
    exit 64
}
[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || {
    echo "::error::PR number 无效：$pr_number。" >&2
    exit 64
}
[ -n "${GH_TOKEN:-}" ] || {
    echo "::error::缺少 GH_TOKEN。" >&2
    exit 1
}

case "$status" in
    success|failure|cancelled) ;;
    *) status=failure ;;
esac

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

{
    echo "$marker"
    echo "## PR Governance"
    echo

    if [ "$status" = "success" ]; then
        echo "- Gate: **PASS**"
    else
        echo "- Gate: **FAIL**"
    fi

    if [ -s "$plan_file" ] && jq -e 'type == "object"' "$plan_file" >/dev/null 2>&1; then
        agent="$(jq -r '.review_agent // "none"' "$plan_file")"
        model="$(jq -r '.review_model // ""' "$plan_file")"
        threshold="$(jq -r '.block_severity // "none"' "$plan_file")"
        risk="$(jq -r '.context.risk // "unknown"' "$plan_file")"
        triage_status="$(jq -r '.triage.status // "not-run"' "$plan_file")"
        triage_action="$(jq -r '.triage.action // "keep"' "$plan_file")"

        printf -- '- Risk: `%s`\n' "$risk"
        printf -- '- Triage: `%s / %s`\n' "$triage_status" "$triage_action"
        printf -- '- Review: `%s`\n' "$agent"
        [ -z "$model" ] || printf -- '- Model: `%s`\n' "$model"
        printf -- '- Blocking threshold: `%s`\n' "$threshold"
    fi

    if [ -s "$result_file" ] && jq -e 'type == "object" and ((.comments // []) | type == "array")' "$result_file" >/dev/null 2>&1; then
        total="$(jq '(.comments // []) | length' "$result_file")"
        critical="$(jq '[.comments[]? | select((.severity // "" | ascii_downcase) == "critical")] | length' "$result_file")"
        high="$(jq '[.comments[]? | select((.severity // "" | ascii_downcase) == "high")] | length' "$result_file")"
        medium="$(jq '[.comments[]? | select((.severity // "" | ascii_downcase) == "medium")] | length' "$result_file")"
        low="$(jq '[.comments[]? | select((.severity // "" | ascii_downcase) == "low")] | length' "$result_file")"

        echo "- Findings: $total (critical $critical · high $high · medium $medium · low $low)"
        echo

        if [ "$total" -gt 0 ]; then
            echo "### Findings"
            echo
            jq -r '
              (.comments // [])[:40][]
              | "- **" + ((.severity // "unknown") | ascii_upcase) + "** "
                + "`" + (.path // "?") + ":" + ((.start_line // .end_line // 0) | tostring) + "` "
                + "[" + (.category // "other") + "] — "
                + ((.content // "") | gsub("[\\r\\n]+"; " ") | .[0:600])
            ' "$result_file"

            if [ "$total" -gt 40 ]; then
                echo
                echo "_仅展示前 40 条；完整结果见 Action Worker run。_"
            fi
        else
            echo
            echo "AI Review 未发现问题。"
        fi
    elif [ "$status" = "success" ]; then
        echo "- AI Review: policy skipped"
    else
        echo
        echo "治理在生成完整 AI Review 结果前失败，请查看 Action Worker run。"
    fi

    echo
    echo "[Action Worker run]($run_url)"
} > "$body_file"

comment_id="$(
    gh api --paginate "repos/$repository/issues/$pr_number/comments?per_page=100"         | jq -r --arg marker "$marker" '.[] | select((.body // "") | contains($marker)) | .id'         | head -n 1
)"

if [ -n "$comment_id" ]; then
    gh api         --method PATCH         "repos/$repository/issues/comments/$comment_id"         -f "body=$(cat "$body_file")"         >/dev/null
    echo "PR governance comment updated: $repository#$pr_number"
else
    gh api         --method POST         "repos/$repository/issues/$pr_number/comments"         -f "body=$(cat "$body_file")"         >/dev/null
    echo "PR governance comment created: $repository#$pr_number"
fi
