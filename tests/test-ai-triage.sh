#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/base-plan.json" <<'JSON'
{
  "context": {
    "changed_files": ["src/example.ts"],
    "project_types": ["node"],
    "change_areas": ["source"],
    "declared_impacts": [],
    "risk": "medium"
  },
  "checks": ["naming"],
  "tests": ["node-test"],
  "ci_required": true,
  "naming_required": true,
  "review_required": true,
  "review_agent": "code",
  "review_model": "Code-Pro",
  "review_rule": "code.json",
  "review_llm_timeout": 300,
  "review_task_timeout": 5,
  "review_concurrency": 1,
  "block_severity": "critical",
  "review_effort": "medium",
  "route_severity": "low"
}
JSON

apply_triage() {
  local input="$1"
  printf '%s\n' "$input" > "$TMP/triage.json"
  bash "$ROOT/scripts/apply-ai-triage.sh" \
    "$TMP/base-plan.json" \
    "$TMP/triage.json" \
    "$ROOT/policies/triage.json" \
    "$ROOT/policies/review.json"
}

skip="$(apply_triage '{"status":"complete","model":"Code-Air","decision":{"review_required":false,"review_agent":"code","risk":"low","depth":"normal","confidence":0.97,"reason":"Trivial local change."}}')"
jq -e '
  .review_required == false
  and .review_agent == "none"
  and .review_model == ""
  and .triage.action == "skip"
' <<< "$skip" >/dev/null

low_confidence="$(apply_triage '{"status":"complete","model":"Code-Air","decision":{"review_required":false,"review_agent":"code","risk":"low","depth":"normal","confidence":0.80,"reason":"Possibly trivial."}}')"
jq -e '
  .review_required == true
  and .review_agent == "code"
  and .review_model == "Code-Pro"
  and .triage.action == "keep"
' <<< "$low_confidence" >/dev/null

security="$(apply_triage '{"status":"complete","model":"Code-Air","decision":{"review_required":true,"review_agent":"security","risk":"high","depth":"deep","confidence":0.88,"reason":"Touches authorization boundary."}}')"
jq -e '
  .review_required == true
  and .review_agent == "security"
  and .review_model == "Code-Ultra"
  and .review_rule == "security.json"
  and .review_effort == "high"
  and .block_severity == "high"
  and .triage.action == "upgrade"
' <<< "$security" >/dev/null

deep="$(apply_triage '{"status":"complete","model":"Code-Air","decision":{"review_required":true,"review_agent":"code","risk":"medium","depth":"deep","confidence":0.91,"reason":"Behavioral change needs deeper review."}}')"
jq -e '
  .review_required == true
  and .review_agent == "code"
  and .review_model == "Code-Ultra"
  and .review_rule == "code.json"
  and .review_effort == "high"
  and .triage.action == "deepen"
' <<< "$deep" >/dev/null

fallback="$(apply_triage '{"status":"unavailable","model":"Code-Air","reason":"request_failed"}')"
jq -e '
  .review_required == true
  and .review_agent == "code"
  and .review_model == "Code-Pro"
  and .triage.status == "unavailable"
  and .triage.action == "keep"
' <<< "$fallback" >/dev/null

jq '.context.declared_impacts = ["breaking"]' "$TMP/base-plan.json" > "$TMP/high-plan.json"
printf '%s\n' '{"status":"complete","model":"Code-Air","decision":{"review_required":false,"review_agent":"code","risk":"low","depth":"normal","confidence":0.99,"reason":"Claims trivial."}}' > "$TMP/triage.json"
protected="$(bash "$ROOT/scripts/apply-ai-triage.sh" \
  "$TMP/high-plan.json" \
  "$TMP/triage.json" \
  "$ROOT/policies/triage.json" \
  "$ROOT/policies/review.json")"
jq -e '
  .review_required == true
  and .review_model == "Code-Pro"
  and .triage.action == "keep"
' <<< "$protected" >/dev/null

echo "AI triage tests passed."
