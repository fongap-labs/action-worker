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
    "contracts/change-record.json", "contracts/pr-task.json", "contracts/release-dispatch.json",
    "contracts/release-manifest.json", "contracts/task-dispatch.json", "policies/execution.json", "policies/triage.json",
    "package.json", "package-lock.json", "tsconfig.json", "scripts/validate-change-record.ts",
    "scripts/validate-engineering-language.ts", "scripts/validate-config-naming.ts",
    "scripts/validate-pr-payload.ts", "scripts/repository-policy.ts", "scripts/validate-control-access.ts", "scripts/validate-ai-gateway-access.ts",
    "scripts/wait-ci-evidence.ts", "scripts/validate-ci-evidence.ts", "scripts/wait-review-turn.ts",
    "scripts/github-api.ts", "scripts/ai-agent-config.ts", "scripts/resolve-bootstrap-model.ts", "scripts/resolve-pr-plan.ts", "scripts/run-ai-triage.ts", "scripts/runtime-command.ts",
    "scripts/apply-ai-triage.ts", "scripts/should-resume-ocr.ts", "scripts/install-ocr.ts", "scripts/set-pr-status.ts",
    "scripts/publish-pr-review.ts", "scripts/publish-release.ts", "scripts/update-work-metrics.ts", "scripts/validate-task-publication.ts",
    "scripts/validate-release-request.ts", ".github/actions/validate-merge-policy/action.yml",
    ".github/workflows/handle-pr-dispatch.yml", ".github/workflows/handle-release-dispatch.yml",
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
  assert.deepEqual((execution.ci as Record<string, unknown>).gate_jobs, ["ci-evidence", "validate-merge"]);
  assert.deepEqual((execution.ci as Record<string, unknown>).central_repositories, [
    "fongap-labs/ai-gateway",
    "fongap-labs/delta",
    "fongap-labs/delta-suite",
    "fongap-labs/app-source",
    "fongap-labs/internal-vault",
    "fongap-labs/external-vault",
  ]);
  assert.equal((execution.ci as Record<string, unknown>).timeout_minutes, 120);

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
    "validate-ai-gateway-access.ts", "run-ai-triage.ts", "apply-ai-triage.ts", "install-ocr.ts", "run-ai-review.ts",
    "Resolve governance ownership", "check-status-owner.ts",
  ]);
  assert.doesNotMatch(workflow, /scripts\/[A-Za-z0-9-]+\.sh/);
  assert.doesNotMatch(workflow, /@alibaba-group\/open-code-review|npm install -g|review_models|review-diff-fallback/);
  assert.doesNotMatch(workflow, /pr-governance-.*github\.sha/);
  assert.doesNotMatch(workflow, /bash\s+target\//);
  assert.doesNotMatch(workflow, /AW_REVIEW_ENGINE_REPOSITORY/);
  assert.match(workflow, /AW_AI_AGENT_CONFIG:\s*\$\{\{ vars\.AW_AI_AGENT_CONFIG \}\}/);
  assert.doesNotMatch(workflow, /AW_IS_AI_REVIEW_ENABLED/);
  const order = ["- name: Collect CI evidence", "- name: Wait for AI queue", "- name: Run AI Triage", "- name: Resolve final plan", "- name: Run AI review", "- name: Validate CI evidence", "- name: Update final gate"];
  const positions = order.map((value) => workflow.indexOf(value));
  assert.ok(positions.every((value) => value >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("task dispatch keeps the publication credential in the central control step", async () => {
  const workflow = await text(".github/workflows/handle-task-dispatch.yml");
  requireText(workflow, [
    "env: ${{ secrets }}", "REPOSITORY_VARS_JSON: ${{ toJSON(vars) }}", "node scripts/export-repository-variables.ts",
    "node scripts/validate-repository-variables.ts", "node scripts/validate-dispatch-payload.ts", "compgen -e",
    "action-worker-base-env.names", "action-worker-repository-vars.json", "AW_REPOSITORY_POLICY", "node-version: 24",
    "node scripts/validate-task-publication.ts", "Publish staged artifact", "secrets.AW_CONTROL_TOKEN",
    "AW_EXECUTION_TOKEN is required.", "Authorization: Bearer ${AW_EXECUTION_TOKEN}",
    "unset AW_EXECUTION_TOKEN AW_CONTROL_TOKEN AW_ADMIN_TOKEN AIG_ACCESS_KEY_AGENT AW_DISPATCH_TOKEN",
  ]);
  assert.doesNotMatch(workflow, /toJSON\s*\(\s*secrets\s*\)/);
  const directSecrets = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(directSecrets)], ["AW_CONTROL_TOKEN"]);
  assert.doesNotMatch(workflow, /Authorization: Bearer \${AW_CONTROL_TOKEN}/);
  assert.doesNotMatch(workflow, /scripts\/[A-Za-z0-9-]+\.sh/);

  const publication = await text("scripts/validate-task-publication.ts");
  requireText(publication, ["release-source", "release-target", "action-worker-publication", "target_repository", "dest_dir"]);
});

test("release, source, deploy, merge, and repository settings contracts remain intact", async () => {
  const release = await text(".github/workflows/handle-release-dispatch.yml");
  requireText(release, ["types: [run-release]", "AW_CONTROL_TOKEN", "node-version: 24", "RELEASE_REQUEST_JSON", "node scripts/publish-release.ts"]);
  assert.doesNotMatch(release, /AW_RELEASE_(?:SOURCE|TARGET)_ALLOWLIST/);
  const releaseValidator = await text("scripts/validate-release-request.ts");
  requireText(releaseValidator, ["AW_REPOSITORY_POLICY", "release-source", "release-target"]);
  assert.doesNotMatch(releaseValidator, /AW_(?:PR|EXECUTION|RELEASE_SOURCE|RELEASE_TARGET)_REPOSITORY_ALLOWLIST/);
  const prValidator = await text("scripts/validate-pr-payload.ts");
  requireText(prValidator, ["AW_REPOSITORY_POLICY"]);
  assert.doesNotMatch(prValidator, /AW_[A-Z_]*ALLOWLIST/);
  const publisher = await text("scripts/publish-release.ts");
  requireText(publisher, ["release-manifest.json", "return `${releaseKey}-v${version}`", "await sha256File(assetPath)", "rollbackRelease", '"draft=true"', '"draft=false"']);
  assert.equal(await exists(".github/workflows/validate-release-policy.yml"), false);
  assert.equal(await exists(".github/workflows/publish-release.yml"), false);

  const source = await text(".github/workflows/validate-source-policy.yml");
  requireText(source, ["workflow_call:", "contents: read", "actions: read", "target_sha:", "ci_workflow:", "require_default_head:", "40-character commit SHA", "default_branch", "gh run list", "databaseId"]);
  const deploy = await text(".github/workflows/validate-deploy-policy.yml");
  requireText(deploy, ["workflow_call:", "uses: ./.github/workflows/validate-source-policy.yml", "target_sha: ${{ inputs.target_sha }}", "ci_workflow: ${{ inputs.ci_workflow }}"]);
  const merge = await text(".github/actions/validate-merge-policy/action.yml");
  requireText(merge, ["ci-result:", "head-sha:", "require-pr-governance:", "PR Governance", "Local CI evidence did not pass", "PR Governance blocked merge"]);

  const repository = await json("policies/repository.json");
  assert.equal(repository.allow_merge_commit, false);
  assert.equal(repository.allow_squash_merge, true);
  assert.equal(repository.delete_branch_on_merge, true);
  const settings = await text(".github/workflows/apply-repo-settings.yml");
  requireText(settings, ["secrets.AW_ADMIN_TOKEN", "inputs.is_dry_run", "node scripts/apply-repo-settings.ts", "node scripts/repository-policy.ts list pr"]);
});

test("self CI runs TypeScript checks without Shell test orchestration", async () => {
  const workflow = await text(".github/workflows/validate-ci.yml");
  requireText(workflow, ["validate-naming-rules.ts", "actionlint", "node-version: 24", "npm run typecheck", "npm test", "validate-merge"]);
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
