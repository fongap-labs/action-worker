#!/usr/bin/env bash

set -Eeuo pipefail

required_files=(
  "AGENTS.md"
  "CLAUDE.md"
  "docs/README.md"
  "docs/ARCHITECTURE.md"
  "docs/ARCHITECTURE_GOVERNANCE.md"
  "docs/NAMING_CONVENTIONS.md"
  "docs/CHANGELOG_CONVENTIONS.md"
  "docs/DEVELOPMENT_GUIDE.md"
  "docs/INTEGRATION_GUIDE.md"
  "contracts/change-record.json"
  "contracts/pr-task.json"
  "contracts/release-dispatch.json"
  "contracts/release-manifest.json"
  "contracts/task-dispatch.json"
  "policies/execution.json"
  "policies/triage.json"
  "package.json"
  "package-lock.json"
  "tsconfig.json"
  "scripts/validate-change-record.sh"
  "scripts/validate-pr-payload.sh"
  "scripts/validate-pr-repository.sh"
  "scripts/validate-control-access.sh"
  "scripts/wait-ci-evidence.sh"
  "scripts/validate-ci-evidence.sh"
  "scripts/wait-review-turn.sh"
  "scripts/github-api.ts"
  "scripts/resolve-pr-plan.ts"
  "scripts/run-ai-triage.ts"
  "scripts/runtime-command.ts"
  "scripts/apply-ai-triage.sh"
  "scripts/should-resume-ocr.sh"
  "scripts/install-ocr.sh"
  "scripts/set-pr-status.sh"
  "scripts/publish-pr-review.sh"
  "scripts/publish-release.ts"
  "scripts/update-work-metrics.ts"
  "scripts/validate-release-request.sh"
  ".github/actions/validate-merge-policy/action.yml"
  ".github/workflows/handle-pr-dispatch.yml"
  ".github/workflows/handle-release-dispatch.yml"
)

for path in "${required_files[@]}"; do
  [ -f "$path" ] || {
    echo "ERROR: missing governance file: $path" >&2
    exit 1
  }
done

for legacy in \
  scripts/publish-release.sh \
  scripts/resolve-pr-plan.sh \
  scripts/run-ai-triage.sh \
  scripts/update-work-metrics.sh; do
  if [ -e "$legacy" ]; then
    echo "ERROR: migrated TypeScript control logic must not keep a legacy Shell entry: $legacy" >&2
    exit 1
  fi
done

for dir in projects adapters profiles; do
  if [ -e "$dir" ]; then
    echo "ERROR: forbidden project-specific directory: $dir/" >&2
    exit 1
  fi
done

if [ -e "policies/repositories.json" ]; then
  echo "ERROR: repository allowlist must come from PR_REPOSITORY_ALLOWLIST, not source policy." >&2
  exit 1
fi

jq -e '
  .private == true
  and .engines.node == ">=24"
  and .scripts.typecheck == "tsc --noEmit"
  and (.scripts.test | startswith("node --test"))
' package.json >/dev/null || {
  echo "ERROR: TypeScript runtime contract is invalid." >&2
  exit 1
}

jq -e '
  .schema_version == 1
  and .control.execute_pr_code == false
  and .control.allow_secrets == true
  and .sandbox.execute_pr_code == true
  and .sandbox.allow_secrets == false
  and .ci.gate_jobs == ["ci-evidence","validate-merge"]
' policies/execution.json >/dev/null || {
  echo "ERROR: execution trust boundary is invalid." >&2
  exit 1
}

jq -e '
  .type == "object"
  and .additionalProperties == false
  and (.required | index("repository") != null)
  and (.required | index("pr_number") != null)
' contracts/pr-task.json >/dev/null || {
  echo "ERROR: invalid PR task contract." >&2
  exit 1
}

jq -e '
  .type == "object"
  and .additionalProperties == false
  and (.required | index("project") != null)
  and (.required | index("bootstrap_ref") != null)
' contracts/task-dispatch.json >/dev/null || {
  echo "ERROR: invalid task dispatch contract." >&2
  exit 1
}

jq -e '
  .schema_version == 2
  and .changelog_file == "CHANGELOG.md"
  and .change_types == ["feat","fix","docs","style","refactor","perf","test","build","ci","chore","revert"]
  and .change_attributes == ["breaking","security","migration"]
  and .changelog_required_types == ["feat","fix","perf","revert"]
' policies/release.json >/dev/null || {
  echo "ERROR: invalid changelog classification policy." >&2
  exit 1
}

jq -e '
  .properties.type.enum == ["feat","fix","docs","style","refactor","perf","test","build","ci","chore","revert"]
  and .properties.attributes.items.enum == ["breaking","security","migration"]
' contracts/change-record.json >/dev/null || {
  echo "ERROR: change record contract diverges from changelog classification." >&2
  exit 1
}

grep -qF 'PR_REPOSITORY_ALLOWLIST' scripts/validate-pr-repository.sh || {
  echo "ERROR: PR repository validator must use PR_REPOSITORY_ALLOWLIST." >&2
  exit 1
}

grep -qF 'Actions Read' scripts/validate-control-access.sh || {
  echo "ERROR: control access validator must require Actions Read." >&2
  exit 1
}

grep -qF 'Commit Statuses Read/Write' scripts/validate-control-access.sh || {
  echo "ERROR: control access validator must require Commit Statuses access." >&2
  exit 1
}

jq -e '
  .schema_version == 1
  and (.agents | type == "object")
  and all(.agents[]; (.model | type == "string" and length > 0) and (has("fallback_models") | not))
  and .runtime.concurrency == 1
  and .runtime.queue_poll_seconds >= 5
  and .runtime.queue_wait_minutes >= 1
  and .runtime.llm_timeout_seconds >= 1
  and (.runtime | has("retry") | not)
  and .engine.name == "open-code-review"
  and (.engine.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
  and (has("repository") | not)
  and (.engine.asset | type == "string" and length > 0)
  and .agents.workflow.effort == "low"
  and .agents.release.effort == "low"
  and .agents.code.effort == "medium"
' policies/review.json >/dev/null || {
  echo "ERROR: AI review runtime policy must remain single-model and queued without outer review retry." >&2
  exit 1
}

grep -qF 'REVIEW_ENGINE_REPOSITORY' .github/workflows/handle-pr-dispatch.yml || {
  echo "ERROR: review engine repository must be supplied by REVIEW_ENGINE_REPOSITORY." >&2
  exit 1
}

jq -e '
  .schema_version == 1
  and .model == "Code-Air"
  and .deep_model == "Code-Ultra"
  and (.enabled_agents | index("code") != null)
  and (.enabled_agents | index("workflow") != null)
  and (.enabled_agents | index("release") != null)
  and .timeout_seconds >= 1
  and .min_skip_confidence >= 0
  and .min_skip_confidence <= 1
  and .min_deep_confidence >= 0
  and .min_deep_confidence <= 1
' policies/triage.json >/dev/null || {
  echo "ERROR: invalid AI triage policy." >&2
  exit 1
}

grep -qF 'repository_dispatch:' .github/workflows/handle-pr-dispatch.yml || {
  echo "ERROR: PR governance must execute from Action Worker repository_dispatch." >&2
  exit 1
}

grep -qF 'run-pr-governance' .github/workflows/handle-pr-dispatch.yml || {
  echo "ERROR: PR governance dispatch event is missing." >&2
  exit 1
}

grep -qF 'pr-governance-${{ github.event.client_payload.repository }}-${{ github.event.client_payload.pr_number }}' .github/workflows/handle-pr-dispatch.yml || {
  echo "ERROR: PR governance concurrency must be stable across Action Worker revisions." >&2
  exit 1
}

if grep -qF 'select(.head_sha == $control_sha)' scripts/wait-review-turn.sh; then
  echo "ERROR: AI Review queue must not split by control-plane revision." >&2
  exit 1
fi

grep -qF 'select(.status == "queued" or .status == "in_progress")' scripts/wait-review-turn.sh || {
  echo "ERROR: AI Review queue must serialize active governance runs globally." >&2
  exit 1
}

grep -qF 'sort_by(.started_at, .id)' scripts/wait-review-turn.sh || {
  echo "ERROR: AI Review queue must order reruns by current-attempt start time before run ID." >&2
  exit 1
}

grep -qF 'run-release' .github/workflows/handle-release-dispatch.yml || {
  echo "ERROR: release governance dispatch event is missing." >&2
  exit 1
}

grep -qF 'GH_RELEASE_TOKEN' .github/workflows/handle-release-dispatch.yml || {
  echo "ERROR: release governance must use the central release credential." >&2
  exit 1
}

grep -qF 'RELEASE_SOURCE_ALLOWLIST' .github/workflows/handle-release-dispatch.yml || {
  echo "ERROR: release governance must validate the source allowlist." >&2
  exit 1
}

grep -qF 'RELEASE_TARGET_ALLOWLIST' .github/workflows/handle-release-dispatch.yml || {
  echo "ERROR: release governance must validate the target allowlist." >&2
  exit 1
}

for legacy in .github/workflows/validate-release-policy.yml .github/workflows/publish-release.yml; do
  if [ -e "$legacy" ]; then
    echo "ERROR: legacy release workflow must not exist: $legacy" >&2
    exit 1
  fi
done

echo "Governance contract tests passed."
