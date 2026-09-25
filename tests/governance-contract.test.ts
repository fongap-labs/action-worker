import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

async function text(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await text(path)) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requireText(content: string, values: readonly string[]): void {
  for (const value of values) {
    assert.ok(content.includes(value), `missing contract text: ${value}`);
  }
}

test("governance files and TypeScript control entries exist", async () => {
  const required = [
    "AGENTS.md", "CLAUDE.md", "docs/README.md", "docs/ARCHITECTURE.md", "docs/ARCHITECTURE_GOVERNANCE.md",
    "docs/NAMING_CONVENTIONS.md", "docs/CHANGELOG_CONVENTIONS.md", "docs/DEVELOPMENT_GUIDE.md",
    "contracts/change-record.json", "contracts/deploy-dispatch.json", "contracts/execution-manifest.json", "contracts/execution-request.json", "contracts/main-write-dispatch.json", "contracts/pr-task.json", "contracts/release-dispatch.json",
    "contracts/release-manifest.json", "contracts/release-provenance.json", "contracts/task-dispatch.json", "policies/capabilities.json", "policies/deploy.json", "policies/execution.json", "policies/runner.json", "policies/rulesets.json", "policies/triage.json",
    "package.json", "package-lock.json", "tsconfig.json", "scripts/validate-change-record.ts",
    "scripts/validate-engineering-language.ts", "scripts/validate-config-naming.ts",
    "scripts/validate-pr-payload.ts", "scripts/repository-policy.ts", "scripts/intake-main-ci.ts", "scripts/intake-open-prs.ts", "scripts/validate-control-access.ts", "scripts/validate-ai-gateway-access.ts", "scripts/validate-security.ts", "scripts/validate-deploy-source.ts", "scripts/dispatch-central-deploy.ts", "scripts/main-write-guard.ts", "scripts/audit-main-writes.ts",
    "scripts/wait-ci-evidence.ts", "scripts/validate-ci-evidence.ts", "scripts/wait-review-turn.ts",
    "scripts/github-api.ts", "scripts/ai-agent-config.ts", "scripts/execution-contract.ts", "scripts/execution-policy.ts", "scripts/resolve-bootstrap-model.ts", "scripts/resolve-ci-capabilities.ts", "scripts/resolve-execution-plan.ts", "scripts/resolve-pr-plan.ts", "scripts/run-ai-triage.ts", "scripts/run-execution-job.ts", "scripts/runner-policy.ts", "scripts/runtime-command.ts",
    "scripts/apply-ai-triage.ts", "scripts/should-resume-ocr.ts", "scripts/install-ocr.ts", "scripts/set-pr-status.ts",
    "scripts/publish-pr-review.ts", "scripts/publish-release.ts", "scripts/sync-tool-release.ts", "scripts/update-work-metrics.ts", "scripts/validate-task-publication.ts",
    "scripts/validate-release-request.ts", ".github/actions/validate-merge-policy/action.yml",
    ".github/workflows/aig-deploy.yml", ".github/workflows/aig-scheduled-ci.yml", ".github/workflows/deployment-readiness.yml", ".github/workflows/handle-pr-dispatch.yml", ".github/workflows/handle-release-dispatch.yml",
    ".github/workflows/ci-intake.yml", ".github/workflows/main-write-audit.yml", ".github/workflows/main-write-guard.yml", ".github/workflows/model-discovery.yml", ".github/workflows/pr-intake.yml", ".github/workflows/release-build.yml", ".github/workflows/server-edge-deploy.yml",
    ".github/workflows/sync-tool-release.yml", ".github/workflows/validate-central-merge.yml",
    ".github/workflows/cancel-pr-work.yml",
  ];
  for (const path of required) {
    assert.equal(await exists(path), true, `missing governance file: ${path}`);
  }
  for (const directory of ["projects", "adapters", "profiles"]) {
    assert.equal(await exists(directory), false, `forbidden project-specific directory: ${directory}`);
  }
  assert.equal(await exists("policies/repositories.json"), false);
  const shellFiles = [
    ...(await readdir("scripts")).filter((name) => name.endsWith(".sh")),
    ...(await readdir("tests")).filter((name) => name.endsWith(".sh")),
  ];
  assert.deepEqual(shellFiles, []);
});

test("integration guidance matches the current credential and private-repository model", async () => {
  const guide = await text("docs/INTEGRATION_GUIDE.md");
  assert.doesNotMatch(guide, /`AW_EXECUTION_TOKEN` 仅用于/);
  assert.match(guide, /AW_EXECUTION_TOKEN.*已删除/);
  assert.match(guide, /GitHub Free.*私有仓库.*不支持 Ruleset 或 Protected Branch/);
});

test("runtime and machine policies preserve trust boundaries", async () => {
  const pkg = await json("package.json");
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.engines, { node: ">=24" });
  const scripts = pkg.scripts as Record<string, unknown>;
  assert.equal(scripts.typecheck, "tsc --noEmit");
  assert.match(String(scripts.test), /^node --test/);

  const execution = await json("policies/execution.json");
  assert.deepEqual(execution.control, { execute_pr_code: false, allow_secrets: true });
  assert.deepEqual(execution.sandbox, { execute_pr_code: true, allow_secrets: false });
  const ciPolicy = execution.ci as Record<string, unknown>;
  assert.equal("workflow" in ciPolicy, false);
  assert.equal("gate_jobs" in ciPolicy, false);
  assert.equal("central_repositories" in ciPolicy, false);
  assert.equal(ciPolicy.status_context, "CI Evidence");
  assert.equal(ciPolicy.timeout_minutes, 120);

  const security = await json("policies/security.json");
  assert.equal(security.schema_version, 2);
  assert.equal(security.require_pinned_actions, true);
  assert.ok(Array.isArray(security.secret_patterns));
  assert.ok(Array.isArray(security.workflow_forbidden_patterns));

  const release = await json("policies/release.json");
  assert.equal(release.schema_version, 2);
  assert.deepEqual(release.change_attributes, ["breaking", "security", "migration"]);
  assert.deepEqual(release.changelog_required_types, ["feat", "fix", "perf", "revert"]);
  assert.equal(Object.keys(release).some((key) => key.endsWith("_repositories")), false);

  const releaseReviewRule = await json("rules/release.json");
  assert.deepEqual(releaseReviewRule.include, ["**/*.jsonc", "CHANGELOG.md"]);

  const review = await json("policies/review.json");
  const runtime = review.runtime as Record<string, unknown>;
  assert.equal(runtime.concurrency, 1);
  assert.equal(runtime.resume_attempts, 3);
  assert.equal(runtime.resume_backoff_seconds, 15);
  assert.equal("retry" in runtime, false);
  const agents = review.agents as Record<string, Record<string, unknown>>;
  assert.equal(agents.workflow?.task_timeout_minutes, 10);
  assert.equal(agents.release?.task_timeout_minutes, 10);
  assert.equal(Object.values(agents).some((agent) => "model" in agent), false);
  const triage = await json("policies/triage.json");
  assert.equal("model" in triage, false);
  assert.equal("deep_model" in triage, false);
  const engine = review.engine as Record<string, unknown>;
  assert.equal(engine.repository, "fongap-labs/external-vault");
  assert.equal(engine.version, "1.12.9");
});

test("PR workflow uses TypeScript controls and preserves ordering", async () => {
  const workflow = await text(".github/workflows/handle-pr-dispatch.yml");
  requireText(workflow, [
    "repository_dispatch:", "types: [run-pr-governance]", "AW_REPOSITORY_POLICY", "AW_CONTROL_TOKEN",
    "AI_GATEWAY_URL", "AIG_ACCESS_KEY_AGENT", "AW_AI_AGENT_CONFIG", "persist-credentials: false", "node-version: 24",
    "validate-pr-payload.ts", "validate-control-access.ts", "set-pr-status.ts", "validate-engineering-language.ts",
    "publish-pr-review.ts", "wait-ci-evidence.ts", "validate-ci-evidence.ts", "wait-review-turn.ts",
    "validate-ai-gateway-access.ts", "validate-security.ts", "run-ai-triage.ts", "apply-ai-triage.ts", "install-ocr.ts", "run-ai-review.ts",
    "Resolve governance ownership", "check-status-owner.ts",
    "Publish explicit no-CI evidence", "steps.base_plan.outputs.ci_required != 'true'",
    "CI not required by governance plan", "for context in \"CI Evidence\" \"ci-evidence\"",
  ]);
  assert.doesNotMatch(workflow, /scripts\/[A-Za-z0-9-]+\.sh/);
  assert.doesNotMatch(workflow, /@alibaba-group\/open-code-review|npm install -g|review_models|review-diff-fallback/);
  assert.doesNotMatch(workflow, /pr-governance-.*github\.sha/);
  assert.doesNotMatch(workflow, /bash\s+target\//);
  assert.doesNotMatch(workflow, /AW_REVIEW_ENGINE_REPOSITORY/);
  assert.match(workflow, /AW_AI_AGENT_CONFIG:\s*\$\{\{ vars\.AW_AI_AGENT_CONFIG \}\}/);
  assert.doesNotMatch(workflow, /AW_IS_AI_REVIEW_ENABLED/);
  const order = ["- name: Validate security gate", "- name: Collect CI evidence", "- name: Publish explicit no-CI evidence", "- name: Validate CI evidence", "- name: Mark deterministic gate passed", "- name: Update final gate", "- name: Wait for AI queue", "- name: Run AI Triage", "- name: Resolve final plan", "- name: Run AI review", "- name: Publish PR review"];
  const positions = order.map((value) => workflow.indexOf(value));
  assert.ok(positions.every((value) => value >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  const aiReviewStep = workflow.slice(workflow.indexOf("      - name: Run AI review"), workflow.indexOf("      - name: Publish PR review"));
  assert.match(aiReviewStep, /continue-on-error: true/);
  assert.doesNotMatch(aiReviewStep, /BLOCK_SEVERITY|block_severity/);
  assert.match(workflow, /Validate CI evidence\n\s+if: steps\.base_plan\.outputs\.ci_required == 'true'/);
  assert.match(workflow, /STATE: \$\{\{ steps\.gate\.outputs\.passed == 'true'/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("- name: Update final gate")), /Wait for AI queue|Run AI Triage|Run AI review/);
  const ciDispatcher = await text("scripts/dispatch-central-ci.ts");
  requireText(ciDispatcher, ["AW_REPOSITORY_POLICY", "validateRepositoryCapability", '"pr"']);
  assert.doesNotMatch(ciDispatcher, /central_repositories|Central CI dispatch skipped/);
  const ciEvidenceWaiter = await text("scripts/wait-ci-evidence.ts");
  requireText(ciEvidenceWaiter, ["waitForCentralStatus", "CI Evidence"]);
  assert.doesNotMatch(ciEvidenceWaiter, /central_repositories|actions\/workflows\/\$\{workflow\}/);
  const prWorkflow = await text(".github/workflows/handle-pr-dispatch.yml");
  assert.match(
    prWorkflow,
    /- name: Dispatch centralized CI[\s\S]*?AW_REPOSITORY_POLICY: \$\{\{ vars\.AW_REPOSITORY_POLICY \}\}[\s\S]*?dispatch-central-ci\.ts/,
  );
  const reviewRunner = await text("scripts/run-ai-review.ts");
  assert.match(reviewRunner, /AI Review \(advisory\)/);
  assert.doesNotMatch(reviewRunner, /merge is blocked|blocking findings|blockSeverity/);
});

test("task dispatch keeps the publication credential in the central control step", async () => {
  const workflow = await text(".github/workflows/handle-task-dispatch.yml");
  requireText(workflow, [
    "env: ${{ secrets }}", "REPOSITORY_VARS_JSON: ${{ toJSON(vars) }}", "node scripts/export-repository-variables.ts",
    "node scripts/validate-repository-variables.ts", "node scripts/validate-dispatch-payload.ts", "compgen -e",
    "action-worker-base-env.names", "action-worker-repository-vars.json", "AW_REPOSITORY_POLICY", "node-version: 24",
    "node scripts/validate-task-publication.ts", "Publish staged artifact", "secrets.AW_CONTROL_TOKEN",
    "AW_CONTROL_TOKEN is required.", "Authorization: Bearer ${AW_CONTROL_TOKEN}",
    "unset AW_CONTROL_TOKEN AW_ADMIN_TOKEN AIG_ACCESS_KEY_AGENT AW_DISPATCH_TOKEN",
  ]);
  assert.doesNotMatch(workflow, /toJSON\s*\(\s*secrets\s*\)/);
  const directSecrets = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(directSecrets)], ["AW_CONTROL_TOKEN"]);
  assert.doesNotMatch(workflow, /AW_EXECUTION_TOKEN/);
  assert.doesNotMatch(workflow, /scripts\/[A-Za-z0-9-]+\.sh/);

  const publication = await text("scripts/validate-task-publication.ts");
  requireText(publication, ["release-source", "release-target", "action-worker-publication", "target_repository", "dest_dir"]);
});

test("release, source, deploy, merge, and repository settings contracts remain intact", async () => {
  const releaseBuild = await text(".github/workflows/release-build.yml");
  requireText(releaseBuild, [
    "types: [run-release-build]",
    "validate-release-build-request.ts",
    "package-release-build.ts",
    "release-build.json",
    "AW_CONTROL_TOKEN",
    "actions/setup-python",
    "actions/setup-node",
    "actions/attest-build-provenance",
    "anchore/sbom-action",
    "run-release",
  ]);
  const releasePackager = await text("scripts/package-release-build.ts");
  requireText(releasePackager, ["release-manifest.json", "release-provenance.json", "artifact_run_id", "source_sha"]);
  const releaseBuildPolicy = await json("policies/release-build.json") as Record<string, unknown>;
  assert.equal(releaseBuildPolicy.schema_version, 1);
  const releaseBuildRepositories = (releaseBuildPolicy.repositories ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(releaseBuildRepositories).sort(), [
    "fongap-labs/app-source",
    "fongap-labs/delta",
  ]);

  const release = await text(".github/workflows/handle-release-dispatch.yml");
  requireText(release, ["types: [run-release]", "source_repository", "source_sha", "artifact_run_id", "AW_CONTROL_TOKEN", "node-version: 24", "RELEASE_REQUEST_JSON", "node scripts/publish-release.ts"]);
  assert.doesNotMatch(release, /AW_RELEASE_(?:SOURCE|TARGET)_ALLOWLIST/);
  const releaseValidator = await text("scripts/validate-release-request.ts");
  requireText(releaseValidator, ["AW_REPOSITORY_POLICY", "release-source", "release-target"]);
  assert.doesNotMatch(releaseValidator, /AW_(?:PR|EXECUTION|RELEASE_SOURCE|RELEASE_TARGET)_REPOSITORY_ALLOWLIST/);
  const prValidator = await text("scripts/validate-pr-payload.ts");
  requireText(prValidator, ["AW_REPOSITORY_POLICY"]);
  assert.doesNotMatch(prValidator, /AW_[A-Z_]*ALLOWLIST/);

  const ciDispatcher = await text("scripts/dispatch-central-ci.ts");
  requireText(ciDispatcher, ["AW_REPOSITORY_POLICY", "validateRepositoryCapability", '"pr"']);
  assert.doesNotMatch(ciDispatcher, /central_repositories|Central CI dispatch skipped/);
  const publisher = await text("scripts/publish-release.ts");
  requireText(publisher, ["release-manifest.json", "release-provenance.json", "artifact_repository", "artifact_run_id", "return `${releaseKey}-v${version}`", "await sha256File(assetPath)", "rollbackRelease", '"draft=true"', '"draft=false"', "assertTrustedMainWrite", "Main Write Guard"]);
  assert.equal(await exists(".github/workflows/validate-release-policy.yml"), false);
  assert.equal(await exists(".github/workflows/publish-release.yml"), false);

  const source = await text(".github/workflows/validate-source-policy.yml");
  requireText(source, ["workflow_call:", "contents: read", "actions: read", "target_sha:", "ci_workflow:", "require_default_head:", "40-character commit SHA", "default_branch", "gh run list", "databaseId"]);
  const deploy = await text(".github/workflows/validate-deploy-policy.yml");
  requireText(deploy, ["workflow_call:", "uses: ./.github/workflows/validate-source-policy.yml", "target_sha: ${{ inputs.target_sha }}", "ci_workflow: ${{ inputs.ci_workflow }}"]);
  const centralMerge = await text(".github/workflows/validate-central-merge.yml");
  requireText(centralMerge, ["workflow_call:", "checks: write", "validate-merge", "CI Evidence", "PR Governance", "check-runs"]);

  const merge = await text(".github/actions/validate-merge-policy/action.yml");
  requireText(merge, ["ci-result:", "head-sha:", "require-pr-governance:", "PR Governance", "Local CI evidence did not pass", "PR Governance blocked merge"]);

  const repository = await json("policies/repository.json");
  const rulesetPolicy = await json("policies/rulesets.json");
  const managedRulesets = rulesetPolicy.rulesets as Array<Record<string, unknown>>;
  assert.deepEqual(managedRulesets.map((rule) => rule.name), ["Protect Main Branch", "Protect Legacy Branches"]);
  assert.equal(repository.allow_merge_commit, false);
  assert.equal(repository.allow_squash_merge, true);
  assert.equal(repository.delete_branch_on_merge, true);
  const settings = await text(".github/workflows/apply-repo-settings.yml");
  requireText(settings, ["secrets.AW_ADMIN_TOKEN", "inputs.is_dry_run", "policies/rulesets.json", "scripts/apply-repo-settings.ts", "node scripts/apply-repo-settings.ts", "node scripts/repository-policy.ts list pr"]);
});

test("closed PR cancellation validates policy and state before owning live concurrency groups", async () => {
  const workflow = await text(".github/workflows/cancel-pr-work.yml");
  requireText(workflow, [
    "types: [cancel-pr-work]",
    "Validate Cancellation Target",
    "AW_REPOSITORY_POLICY: ${{ vars.AW_REPOSITORY_POLICY }}",
    'node scripts/validate-pr-payload.ts "$PAYLOAD"',
    "secrets.AW_CONTROL_TOKEN",
    `gh api "repos/$REPOSITORY/pulls/$PR_NUMBER" --jq '.state'`,
    "Cancellation target is not closed",
    "needs: validate",
    "pr-governance-${{ needs.validate.outputs.repository }}-${{ needs.validate.outputs.pr_number }}",
    "central-ci-${{ needs.validate.outputs.repository }}-${{ needs.validate.outputs.pr_number }}",
    "cancel-in-progress: true",
  ]);
  assert.doesNotMatch(workflow, /group: (?:pr-governance|central-ci)-\$\{\{ github\.event\.client_payload/);
  assert.doesNotMatch(workflow, /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)\|/);
});

test("AI Gateway scheduled CI is central and cannot publish deploy-triggering status", async () => {
  const workflow = await text(".github/workflows/aig-scheduled-ci.yml");
  requireText(workflow, [
    "schedule:",
    "repository: fongap-labs/ai-gateway",
    "target/.github/scripts/central-ci.sh",
    'CENTRAL_CI_PR_NUMBER: "0"',
  ]);
  assert.equal(workflow.includes("set-pr-status.ts"), false);
  assert.equal(workflow.includes("CI Evidence"), false);
});

test("central CI deploy dispatch is policy-driven after cutover", async () => {
  const policy = await json("policies/deploy.json") as Record<string, unknown>;
  assert.equal(policy.schema_version, 1);
  const repositories = policy.repositories as Record<string, Record<string, unknown>>;
  assert.equal(repositories["fongap-labs/ai-gateway"]?.automatic, true);
  assert.equal(repositories["fongap-labs/ai-gateway"]?.event_type, "run-ai-gateway-deploy");
  assert.equal(repositories["fongap-labs/internal-vault"]?.automatic, false);
  assert.equal(repositories["fongap-labs/internal-vault"]?.event_type, "run-server-edge-deploy");

  const workflow = await text(".github/workflows/central-ci-dispatch.yml");
  requireText(workflow, [
    "Central CI / Security",
    "validate-security.ts",
    "SECURITY_RESULT",
    "needs.security.result == 'success'",
    "Dispatch automatic deploy",
    "dispatch-central-deploy.ts",
    "policies/deploy.json",
    "needs.prepare.outputs.pr_number == '0'",
    "contents: write",
    "AW_REPOSITORY_POLICY",
    'repository-policy.ts validate "$REPOSITORY" pr',
    'resolve-ci-capabilities.ts "$REPOSITORY" "$CONTROL_REF"',
    "needs.prepare.outputs.has_windows == 'true'",
  ]);
  assert.doesNotMatch(workflow, /case "\$REPOSITORY"|needs\.prepare\.outputs\.repository == 'fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)'|fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)\|/);
  assert.match(workflow, /for context in "CI Evidence" "ci-evidence"; do/);
  assert.doesNotMatch(workflow, /for context in "CI Evidence" "ci-evidence" "validate-merge"/);
});

test("AI Gateway deploy execution is central and source-gated", async () => {
  const workflow = await text(".github/workflows/aig-deploy.yml");
  requireText(workflow, [
    "types: [run-ai-gateway-deploy]",
    "validate-deploy-source.ts fongap-labs/ai-gateway true",
    "vars.AIG_IS_DEPLOY_ENABLED != 'false'",
    "AIG_OAUTH_PROVIDERS: ${{ vars.AIG_OAUTH_PROVIDERS }}",
    "AIG_TOKEN_ENCRYPTION_KEY: ${{ secrets.AIG_TOKEN_ENCRYPTION_KEY }}",
    "repository: ${{ needs.prepare.outputs.source_repository }}",
    "npm run validate:deploy",
    "npm run check:deploy",
    "wrangler@4.114.0 d1 migrations apply",
    "wrangler@4.114.0 deploy",
    "Rollback to previous Worker version",
    "health-check --from-env --expected-build",
  ]);
  assert.equal(workflow.includes("workflow_run:"), false);
  assert.equal(workflow.includes("schedule:"), false);

  const validator = await text("scripts/validate-deploy-source.ts");
  requireText(validator, [
    "CI Evidence",
    "assertTrustedMainWrite",
    "Main Write Guard",
    "fongap-labs/action-worker/actions/runs/",
    "requireDefaultHeadRaw",
    "source_repository",
    "source_sha",
  ]);
});

test("Server Edge deploy execution is central and reuses project deployment logic", async () => {
  const workflow = await text(".github/workflows/server-edge-deploy.yml");
  requireText(workflow, [
    "types: [run-server-edge-deploy]",
    "validate-deploy-source.ts fongap-labs/internal-vault true",
    "SERVER_EDGE_TRANSPORT",
    "SERVER_EDGE_TARGET_HOST",
    "SERVER_EDGE_SECRET_BUNDLE",
    "tailscale/github-action",
    "bash environments/server-edge/deploy.sh",
  ]);
  assert.doesNotMatch(workflow, /^\s+EDGE_TARGET_HOST:\s*\$\{\{\s*vars\./m);
  assert.equal(workflow.includes("schedule:"), false);
});

test("deployment readiness is non-destructive and central", async () => {
  const workflow = await text(".github/workflows/deployment-readiness.yml");
  requireText(workflow, [
    "AI Gateway deployment readiness",
    "Server Edge deployment readiness",
    "repository: fongap-labs/ai-gateway",
    "AIG_OAUTH_PROVIDERS: ${{ vars.AIG_OAUTH_PROVIDERS }}",
    "AIG_TOKEN_ENCRYPTION_KEY: ${{ secrets.AIG_TOKEN_ENCRYPTION_KEY }}",
    "repository: fongap-labs/internal-vault",
    "github-deployment-config.mjs prepare --from-env",
    "services/server-edge/install/validate.sh --static",
    "environments/server-edge/materialize.py",
  ]);
  assert.equal(workflow.includes("wrangler@4.114.0 deploy"), false);
  assert.equal(workflow.includes("environments/server-edge/deploy.sh"), false);
});

test("AI Gateway model discovery runs from the central control plane", async () => {
  const workflow = await text(".github/workflows/model-discovery.yml");
  requireText(workflow, [
    "schedule:",
    "repository: fongap-labs/ai-gateway",
    "secrets.AW_CONTROL_TOKEN",
    "provider-discovery.mjs live",
    "model-discovery",
  ]);
});

test("tool distribution sync runs only in the central control plane", async () => {
  const workflow = await text(".github/workflows/sync-tool-release.yml");
  requireText(workflow, [
    "schedule:",
    "sync-tool-release.ts",
    "AW_CONTROL_TOKEN",
    "run-release",
    "schema_version: \"2\"",
    "artifact_repository",
    "artifact_run_id",
  ]);
  const script = await text("scripts/sync-tool-release.ts");
  requireText(script, [
    "tools/catalog.json",
    "release-provenance.json",
    "CI Evidence",
    "checksumForAsset",
    "selectStableRelease",
  ]);
});

test("self CI requires deterministic security checks", async () => {
  const workflow = await text(".github/workflows/validate-ci.yml");
  requireText(workflow, ["Security checks", "validate-security.ts", "SECURITY_RESULT", "validate-naming-rules.ts", "actionlint", "node-version: 24", "npm run typecheck", "npm test", "validate-merge"]);
  assert.doesNotMatch(workflow, /shellcheck|tests\/test-[A-Za-z0-9-]+\.sh/);
});

test("metrics workflow delegates branch and PR orchestration to TypeScript", async () => {
  const workflow = await text(".github/workflows/update-work-metrics.yml");
  for (const stage of ["increment", "changes", "branch", "pull", "cleanup", "ci", "merge"]) {
    assert.ok(workflow.includes(`node scripts/manage-work-metrics.ts ${stage}`));
  }
  assert.doesNotMatch(workflow, /shell:\s+bash|run:\s*\|/);
  assert.match(workflow, /METRICS_TOKEN:.*AW_CONTROL_TOKEN/);
  assert.ok((workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length >= 5);
  assert.equal((workflow.match(/GH_TOKEN: \$\{\{ secrets\.AW_CONTROL_TOKEN \}\}/g) ?? []).length, 1);
  const pullStep = workflow.slice(workflow.indexOf("      - name: Create auto-update PR"), workflow.indexOf("      - name: Wait for CI"));
  assert.match(pullStep, /GH_TOKEN: \$\{\{ secrets\.AW_CONTROL_TOKEN \}\}/);
  assert.match(workflow, /Cleanup failed metrics update/);
  assert.match(workflow, /Sweep stale metrics branches/);
  assert.match(workflow, /node scripts\/manage-work-metrics\.ts sweep/);
  const sweepJob = workflow.slice(workflow.indexOf("  sweep:"), workflow.indexOf("  update:"));
  const updateJob = workflow.slice(workflow.indexOf("  update:"));
  assert.match(sweepJob, /node scripts\/manage-work-metrics\.ts sweep/);
  assert.doesNotMatch(updateJob, /node scripts\/manage-work-metrics\.ts sweep/);
  assert.match(workflow, /needs: sweep/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /update-work-metrics\.yml/);
  assert.match(workflow, /scripts\/manage-work-metrics\.ts/);
  assert.match(workflow, /scripts\/update-work-metrics\.ts/);
  assert.match(workflow, /Handle Release Dispatch/);
  assert.match(workflow, /github\.event_name != 'workflow_run'/);
  assert.doesNotMatch(workflow, /github\.event_name != 'push'/);
  assert.doesNotMatch(workflow, /gh workflow run validate-ci\.yml/);
  const metricsScript = await text("scripts/manage-work-metrics.ts");
  assert.match(metricsScript, /"api", "--method", "GET", `repos\/\$\{repository\}\/pulls`/);
  assert.match(workflow, /node scripts\/repository-policy\.ts list pr/);
});


test("main write guard is the post-merge provenance authority", async () => {
  const workflow = await text(".github/workflows/main-write-guard.yml");
  requireText(workflow, [
    "push:",
    "branches: [main]",
    "types: [run-main-write-guard]",
    "Main Write Guard",
    "MAIN_WRITE_REQUIRE_CENTRAL_STATUSES",
    "node scripts/main-write-guard.ts",
    "secrets.AW_CONTROL_TOKEN",
  ]);
  const guard = await text("scripts/main-write-guard.ts");
  requireText(guard, [
    "merge_commit_sha",
    "validate-merge",
    "github-actions",
    "PR Governance",
    "CI Evidence",
    "Main Write Guard",
    "assertTrustedMainWrite",
  ]);
  assert.doesNotMatch(guard, /commit message|actor.*trusted|bypass/i);
});


test("central main write audit is independent of business repository Actions", async () => {
  const workflow = await text(".github/workflows/main-write-audit.yml");
  requireText(workflow, [
    'cron: "*/5 * * * *"',
    "workflow_dispatch:",
    "AW_CONTROL_TOKEN",
    "AW_REPOSITORY_POLICY",
    "node scripts/audit-main-writes.ts",
  ]);
  const script = await text("scripts/audit-main-writes.ts");
  requireText(script, [
    'repositoriesForCapability(policy, "pr")',
    "validateMainWriteProvenance",
    "Main Write Guard",
    "commits/main",
  ]);
  assert.doesNotMatch(workflow, /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)/);
  assert.doesNotMatch(script, /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)/);
});
