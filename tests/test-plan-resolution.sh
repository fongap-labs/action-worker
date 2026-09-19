#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVER="$ROOT/scripts/resolve-pr-plan.ts"
POLICIES="$ROOT/policies"

docs='{
  "project_types":["node"],
  "change_areas":["documentation"],
  "declared_impacts":[],
  "risk":"low"
}'

workflow='{
  "project_types":["github-automation"],
  "change_areas":["workflow"],
  "declared_impacts":[],
  "risk":"medium"
}'

breaking='{
  "project_types":["node"],
  "change_areas":["source","release"],
  "declared_impacts":["breaking","api","compatibility"],
  "risk":"high"
}'

security='{
  "project_types":["node"],
  "change_areas":["script","security"],
  "declared_impacts":["security"],
  "risk":"high"
}'

docs_plan="$(node "$RESOLVER" "$docs" inherit inherit inherit inherit auto auto "$POLICIES")"
jq -e '
  .checks == ["naming"]
  and .tests == []
  and .ci_required == false
  and .review_required == false
  and .review_agent == "none"
  and .review_model == ""
  and (has("review_models") | not)
  and .review_llm_timeout == 0
  and .review_task_timeout == 0
  and .review_concurrency == 0
  and .triage_required == false
  and .triage_model == ""
  and .triage_timeout == 0
' <<< "$docs_plan" >/dev/null

workflow_plan="$(node "$RESOLVER" "$workflow" inherit inherit inherit inherit auto auto "$POLICIES")"
jq -e '
  (.checks | index("naming")) != null
  and (.checks | index("actionlint")) != null
  and .tests == []
  and .ci_required == true
  and .review_required == true
  and .review_agent == "workflow"
  and .review_model == "Code-Pro"
  and (has("review_models") | not)
  and .review_llm_timeout == 300
  and .review_task_timeout == 2
  and .review_concurrency == 1
  and .triage_required == true
  and .triage_model == "Code-Air"
  and .triage_timeout == 60
  and .review_effort == "low"
  and .block_severity == "critical"
  and .review_rule == "workflow.json"
' <<< "$workflow_plan" >/dev/null

breaking_plan="$(node "$RESOLVER" "$breaking" inherit inherit inherit inherit auto auto "$POLICIES")"
jq -e '
  (.checks | index("api-check")) != null
  and (.checks | index("compatibility-check")) != null
  and (.tests | index("node-test")) != null
  and (.tests | index("integration-test")) != null
  and (.tests | index("api-test")) != null
  and (.tests | index("compatibility-test")) != null
  and .ci_required == true
  and .review_agent == "architecture"
  and .review_model == "Code-Ultra"
  and .review_llm_timeout == 300
  and .review_task_timeout == 2
  and .review_concurrency == 1
  and .triage_required == false
  and .triage_model == ""
  and .triage_timeout == 0
  and .review_effort == "high"
  and .block_severity == "high"
  and .review_rule == "architecture.json"
' <<< "$breaking_plan" >/dev/null

security_plan="$(node "$RESOLVER" "$security" inherit inherit inherit inherit auto auto "$POLICIES")"
jq -e '
  (.checks | index("shellcheck")) != null
  and (.checks | index("secret-scan")) != null
  and (.tests | index("node-test")) != null
  and .ci_required == true
  and .review_agent == "security"
  and .review_model == "Code-Ultra"
  and .review_llm_timeout == 300
  and .review_task_timeout == 2
  and .review_concurrency == 1
  and .triage_required == false
  and .triage_model == ""
  and .triage_timeout == 0
  and .review_effort == "high"
' <<< "$security_plan" >/dev/null

override="$(node "$RESOLVER" "$breaking" off on critical low Code-Air code "$POLICIES")"
jq -e '
  .naming_required == false
  and .review_required == true
  and .review_agent == "code"
  and .review_model == "Code-Air"
  and .review_llm_timeout == 300
  and .review_task_timeout == 2
  and .review_concurrency == 1
  and .triage_required == true
  and .triage_model == "Code-Air"
  and .triage_timeout == 60
  and .review_effort == "low"
  and .block_severity == "critical"
  and .review_rule == "code.json"
' <<< "$override" >/dev/null

echo "PR plan resolution tests passed."
