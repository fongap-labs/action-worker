import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
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
    "AGENTS.md",
    "CLAUDE.md",
    "docs/README.md",
    "docs/ARCHITECTURE.md",
    "docs/ARCHITECTURE_GOVERNANCE.md",
    "docs/NAMING_CONVENTIONS.md",
    "docs/CHANGELOG_CONVENTIONS.md",
    "docs/DEVELOPMENT_GUIDE.md",
    "contracts/change-record.json",
    "contracts/dependency-repair.json",
    "contracts/deploy-dispatch.json",
    "contracts/deploy-manifest.json",
    "contracts/execution-manifest.json",
    "contracts/execution-request.json",
    "contracts/main-write-dispatch.json",
    "contracts/pr-task.json",
    "contracts/release-build.json",
    "contracts/release-dispatch.json",
    "contracts/release-manifest.json",
    "contracts/release-provenance.json",
    "contracts/security-scan.json",
    "contracts/task-dispatch.json",
    "contracts/task-source.json",
    "policies/capabilities.json",
    "policies/deploy.json",
    "policies/execution.json",
    "policies/runner.json",
    "policies/rulesets.json",
    "policies/triage.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts/validate-change-record.ts",
    "scripts/validate-engineering-language.ts",
    "scripts/validate-config-naming.ts",
    "scripts/validate-pr-payload.ts",
    "scripts/repository-policy.ts",
    "scripts/deploy-manifest.ts",
    "scripts/intake-main-ci.ts",
    "scripts/intake-open-prs.ts",
    "scripts/intake-security-scans.ts",
    "scripts/intake-task-sources.ts",
    "scripts/validate-control-access.ts",
    "scripts/validate-ai-endpoint-access.ts",
    "scripts/validate-security.ts",
    "scripts/validate-deploy-source.ts",
    "scripts/dispatch-central-deploy.ts",
    "scripts/main-write-guard.ts",
    "scripts/audit-main-writes.ts",
    "scripts/wait-ci-evidence.ts",
    "scripts/validate-ci-evidence.ts",
    "scripts/wait-review-turn.ts",
    "scripts/check-review-target.ts",
    "scripts/dispatch-pr-review.ts",
    "scripts/github-api.ts",
    "scripts/ai-agent-config.ts",
    "scripts/collect-dependency-repair.ts",
    "scripts/dependency-repair.ts",
    "scripts/dispatch-security-scan.ts",
    "scripts/execution-contract.ts",
    "scripts/execution-policy.ts",
    "scripts/resolve-ci-capabilities.ts",
    "scripts/resolve-ci-control-ref.ts",
    "scripts/resolve-dependency-repair.ts",
    "scripts/resolve-release-build-ingress.ts",
    "scripts/resolve-execution-plan.ts",
    "scripts/resolve-pr-plan.ts",
    "scripts/resolve-security-scan.ts",
    "scripts/run-ai-triage.ts",
    "scripts/run-execution-job.ts",
    "scripts/security-scan.ts",
    "scripts/runner-policy.ts",
    "scripts/runtime-command.ts",
    "scripts/apply-ai-triage.ts",
    "scripts/should-resume-ocr.ts",
    "scripts/install-ocr.ts",
    "scripts/set-pr-status.ts",
    "scripts/resolve-agent-skills.ts",
    "scripts/build-agent-prompt.ts",
    "scripts/publish-dependency-repair.ts",
    "scripts/publish-pr-review.ts",
    "scripts/publish-release.ts",
    "scripts/publish-security-scan.ts",
    "scripts/sync-tool-release.ts",
    "scripts/update-work-metrics.ts",
    "scripts/dispatch-scheduled-tasks.ts",
    "scripts/validate-task-publication.ts",
    "scripts/validate-release-request.ts",
    ".github/actions/validate-merge-policy/action.yml",
    ".github/workflows/handle-pr-dispatch.yml",
    ".github/workflows/handle-pr-review.yml",
    ".github/workflows/handle-release-dispatch.yml",
    ".github/workflows/dependency-repair-dispatch.yml",
    ".github/workflows/intake.yml",
    ".github/workflows/main-write-guard.yml",
    ".github/workflows/release-app.yml",
    ".github/workflows/security-scan-dispatch.yml",
    ".github/workflows/deploy-source-script.yml",
    ".github/workflows/release-tool.yml",
    ".github/workflows/task-source-dispatch.yml",
    ".github/workflows/cancel-pr-work.yml",
    "skills/writing/SKILL.md",
  ];
  for (const path of required) {
    assert.equal(await exists(path), true, `missing governance file: ${path}`);
  }
  for (const directory of ["projects", "adapters", "profiles"]) {
    assert.equal(
      await exists(directory),
      false,
      `forbidden project-specific directory: ${directory}`
    );
  }
  assert.equal(await exists("policies/repositories.json"), false);
  const shellFiles = [
    ...(await readdir("scripts")).filter((name) => name.endsWith(".sh")),
    ...(await readdir("tests")).filter((name) => name.endsWith(".sh")),
  ];
  assert.deepEqual(shellFiles, []);
});

test("workflows use the canonical setup-node action runtime", async () => {
  const canonical = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";
  const retired = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0";
  const workflows = (await readdir(".github/workflows")).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml")
  );

  for (const name of workflows) {
    const workflow = await text(`.github/workflows/${name}`);
    assert.equal(workflow.includes(retired), false, `retired setup-node pin in ${name}`);
    if (workflow.includes("actions/setup-node@")) {
      assert.equal(workflow.includes(canonical), true, `non-canonical setup-node pin in ${name}`);
    }
  }
});

test("Intake reconciles every kind of work on the heartbeat, never by hand", async () => {
  const workflow = await text(".github/workflows/intake.yml");
  requireText(workflow, [
    "push:",
    "branches: [main]",
    "types: [run-intake]",
    'cron: "*/5 * * * *"',
    "group: intake",
    "intake-open-prs.ts",
    "intake-main-ci.ts",
    "audit-main-writes.ts",
    "MAIN_WRITE_AUDIT_RUN_URL",
    "intake-task-sources.ts",
    "dispatch-scheduled-tasks.ts",
    'TASK_SOURCE_LOOKBACK_MINUTES: "720"',
    "intake-security-scans.ts",
  ]);
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  // The weekly rescan dispatches without deduplication, so it never runs on the heartbeat.
  const securityScans = workflow.slice(workflow.indexOf("  security-scans:"));
  assert.match(securityScans, /if: github\.event\.schedule == '17 3 \* \* 1'/);
  assert.match(workflow, /cron: "17 3 \* \* 1"/);
  for (const retired of [
    "pr-intake.yml",
    "ci-intake.yml",
    "task-intake.yml",
    "security-scan-intake.yml",
    "main-write-audit.yml",
  ]) {
    assert.equal(
      await exists(`.github/workflows/${retired}`),
      false,
      `${retired} is part of Intake`
    );
  }

  const audit = await text("scripts/audit-main-writes.ts");
  requireText(audit, [
    "MAIN_WRITE_AUDIT_REPOSITORY",
    "managedRepositories.includes(requestedRepository)",
    "requestedRepository ? [requestedRepository] : managedRepositories",
  ]);
});

test("integration guidance matches the current credential and private-repository model", async () => {
  const guide = await text("docs/INTEGRATION_GUIDE.md");
  assert.doesNotMatch(guide, /`AW_EXECUTION_TOKEN` 仍在使用/);
  assert.match(guide, /`AW_EXECUTION_TOKEN` 已被删除/);
  assert.match(guide, /在 GitHub Free 套餐下，组织的私有仓库不支持 rulesets 或保护分支/);
});

test("the integration guide says which workflow starts a release or a deploy", async () => {
  const guide = await text("docs/INTEGRATION_GUIDE.md");
  const workflows: Record<string, string> = {
    "Release App": ".github/workflows/release-app.yml",
    "Release Tool": ".github/workflows/release-tool.yml",
    "Deploy Source Script": ".github/workflows/deploy-source-script.yml",
  };
  for (const [displayName, path] of Object.entries(workflows)) {
    assert.match(await text(path), new RegExp(`^name: ${displayName}$`, "m"), path);
    requireText(guide, [`\`${displayName}\` (\`${path.split("/").pop()}\`)`]);
  }
});

test("test ownership points every governance document to the test packs", async () => {
  for (const path of [
    "docs/ARCHITECTURE_GOVERNANCE.md",
    "docs/ARCHITECTURE.md",
    "docs/DEVELOPMENT_GUIDE.md",
    "docs/EXECUTION_CONTRACT.md",
    "docs/INTEGRATION_GUIDE.md",
  ]) {
    assert.match(await text(path), /TEST_PACKS\.md/, `${path} must reference TEST_PACKS.md`);
  }
  requireText(await text("docs/TEST_PACKS.md"), [
    "## 6. 留在业务仓库中的测试",
    "Action Worker 持有每个受管业务仓库的测试",
  ]);
});

test("documentation readability convention is enforced in shared governance", async () => {
  const gov = await text("docs/SHARED_GOVERNANCE.md");
  requireText(gov, [
    "文档可读性",
    "机器读取文档（严格）",
    "人类阅读文档（面向新人）",
    '先说明"这是什么"，再说明"怎么做"',
    "解释每个术语",
    "用示例代替抽象描述",
    "精确且无歧义",
    "**英文**",
    "**中文**",
  ]);
  const dev = await text("docs/DEVELOPMENT_GUIDE.md");
  requireText(dev, ["没有项目背景的人也能读懂"]);
});

test("skills README is beginner-friendly", async () => {
  const readme = await text("skills/README.md");
  requireText(readme, [
    "What is a skill",
    "How to use",
    "How to add a new skill",
    "agent_domain",
    "frontmatter",
  ]);
  assert.ok(readme.includes("You do not need to configure anything"));
});

test("runtime and machine policies preserve trust boundaries", async () => {
  const pkg = await json("package.json");
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.engines, { node: ">=24" });
  const scripts = pkg.scripts as Record<string, unknown>;
  assert.equal(scripts.typecheck, "tsc --noEmit");
  assert.match(String(scripts.test), /^node --test/);

  const runnerPolicy = await json("policies/runner.json");
  const runnerProfiles = runnerPolicy.profiles as Record<string, Record<string, unknown>>;
  assert.deepEqual(runnerProfiles["production-deploy"], {
    enabled: true,
    backend: "github-hosted",
    trust_domain: "privileged",
    labels: ["ubuntu-24.04"],
    fallback_profiles: [],
  });

  const repositoryPolicy = await text("scripts/repository-policy.ts");
  requireText(repositoryPolicy, ['"deploy"']);

  const deployManifest = await text("scripts/deploy-manifest.ts");
  requireText(deployManifest, [
    ".github/deploy.json",
    'validateRepositoryCapability(repository, repositoryPolicyValue, "deploy")',
    "resolveRunnerProfile",
    "privileged",
  ]);
  assert.doesNotMatch(deployManifest, /fongap-labs\/(?:ai-gateway|internal-vault)/);

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
  assert.equal(
    Object.keys(release).some((key) => key.endsWith("_repositories")),
    false
  );

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
  assert.equal(
    Object.values(agents).some((agent) => "model" in agent),
    false
  );
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
    "repository_dispatch:",
    "types: [run-pr-governance]",
    "AW_REPOSITORY_POLICY",
    "AW_CONTROL_TOKEN",
    "AW_AI_AGENT_CONFIG",
    "persist-credentials: false",
    "node-version: 24",
    "validate-pr-payload.ts",
    "validate-control-access.ts",
    "set-pr-status.ts",
    "validate-engineering-language.ts",
    "publish-pr-review.ts",
    "wait-ci-evidence.ts",
    "validate-ci-evidence.ts",
    "validate-security.ts",
    "dispatch-pr-review.ts",
    "Resolve governance ownership",
    "check-status-owner.ts",
    "Publish explicit no-CI evidence",
    "steps.base_plan.outputs.ci_required != 'true'",
    "CI not required by governance plan",
    "context=CI Evidence",
  ]);
  assert.doesNotMatch(workflow, /scripts\/[A-Za-z0-9-]+\.sh/);
  assert.doesNotMatch(
    workflow,
    /@alibaba-group\/open-code-review|npm install -g|review_models|review-diff-fallback/
  );
  assert.doesNotMatch(workflow, /pr-governance-.*github\.sha/);
  assert.doesNotMatch(workflow, /bash\s+target\//);
  assert.doesNotMatch(workflow, /AW_REVIEW_ENGINE_REPOSITORY/);
  assert.match(workflow, /AW_AI_AGENT_CONFIG:\s*\$\{\{ vars\.AW_AI_AGENT_CONFIG \}\}/);
  assert.doesNotMatch(workflow, /AW_IS_AI_REVIEW_ENABLED/);
  const order = [
    "- name: Validate security gate",
    "- name: Collect CI evidence",
    "- name: Publish explicit no-CI evidence",
    "- name: Validate CI evidence",
    "- name: Mark deterministic gate passed",
    "- name: Update final gate",
    "- name: Publish PR review",
    "- name: Dispatch AI review",
  ];
  const positions = order.map((value) => workflow.indexOf(value));
  assert.ok(positions.every((value) => value >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right)
  );
  // AI Review is never part of this run: it cannot queue, delay or change the gate.
  assert.doesNotMatch(
    workflow,
    /Wait for AI queue|Run AI Triage|Run AI review|wait-review-turn|run-ai-triage|run-ai-review|apply-ai-triage|install-ocr|validate-ai-endpoint-access|AIG_ACCESS_KEY_AGENT|AI_GATEWAY_URL/
  );
  const dispatchStep = workflow.slice(workflow.indexOf("      - name: Dispatch AI review"));
  assert.match(dispatchStep, /continue-on-error: true/);
  assert.match(dispatchStep, /steps\.gate\.outputs\.passed == 'true'/);
  assert.match(dispatchStep, /steps\.ownership\.outputs\.current == 'true'/);
  assert.match(dispatchStep, /steps\.base_plan\.outputs\.review_required == 'true'/);
  assert.match(
    workflow,
    /Validate CI evidence\n\s+if: steps\.trust\.outputs\.trusted == 'true' && steps\.base_plan\.outputs\.ci_required == 'true'/
  );
  assert.match(workflow, /STATE: \$\{\{ steps\.gate\.outputs\.passed == 'true'/);
  const ciDispatcher = await text("scripts/dispatch-central-ci.ts");
  requireText(ciDispatcher, ["AW_REPOSITORY_POLICY", "validateRepositoryCapability", '"pr"']);
  assert.doesNotMatch(ciDispatcher, /central_repositories|Central CI dispatch skipped/);
  const ciEvidenceWaiter = await text("scripts/wait-ci-evidence.ts");
  requireText(ciEvidenceWaiter, ["waitForCentralStatus", "CI Evidence"]);
  assert.doesNotMatch(ciEvidenceWaiter, /central_repositories|actions\/workflows\/\$\{workflow\}/);
  const prWorkflow = await text(".github/workflows/handle-pr-dispatch.yml");
  assert.match(
    prWorkflow,
    /- name: Dispatch centralized CI[\s\S]*?AW_REPOSITORY_POLICY: \$\{\{ vars\.AW_REPOSITORY_POLICY \}\}[\s\S]*?dispatch-central-ci\.ts/
  );
  const reviewRunner = await text("scripts/run-ai-review.ts");
  assert.match(reviewRunner, /AI Review \(advisory\)/);
  assert.doesNotMatch(reviewRunner, /merge is blocked|blocking findings|blockSeverity/);
});

test("AI review runs as its own advisory workflow after the gate", async () => {
  const workflow = await text(".github/workflows/handle-pr-review.yml");
  requireText(workflow, [
    "repository_dispatch:",
    "types: [run-pr-review]",
    "group: pr-review-${{ github.event.client_payload.repository }}-${{ github.event.client_payload.pr_number }}",
    "cancel-in-progress: true",
    "AW_REPOSITORY_POLICY",
    "AW_CONTROL_TOKEN",
    "AI_GATEWAY_URL",
    "AIG_ACCESS_KEY_AGENT",
    "persist-credentials: false",
    "node-version: 24",
    "validate-pr-payload.ts",
    "validate-control-access.ts",
    "check-review-target.ts",
    "wait-ci-evidence.ts",
    "validate-ai-endpoint-access.ts",
    "wait-review-turn.ts",
    '"handle-pr-review.yml"',
    "run-ai-triage.ts",
    "apply-ai-triage.ts",
    "install-ocr.ts",
    "run-ai-review.ts",
    "publish-pr-review.ts",
  ]);
  assert.match(workflow, /AW_AI_AGENT_CONFIG:\s*\$\{\{ vars\.AW_AI_AGENT_CONFIG \}\}/);
  assert.doesNotMatch(workflow, /scripts\/[A-Za-z0-9-]+\.sh/);
  assert.doesNotMatch(
    workflow,
    /@alibaba-group\/open-code-review|npm install -g|review-diff-fallback/
  );
  // The review workflow can never write a gate status, so it cannot change a merge decision.
  assert.doesNotMatch(
    workflow,
    /set-pr-status|validate-merge|PR_STATUS_CONTEXT|Update final gate|Mark deterministic gate/
  );
  assert.equal((workflow.match(/node scripts\/run-ai-review\.ts/g) ?? []).length, 1);
  assert.match(workflow, /if: needs\.prepare\.outputs\.current == 'true'/);
  const order = [
    "- name: Confirm the gate passed for the requested head",
    "- name: Checkout target PR",
    "- name: Resolve base plan",
    "- name: Wait for AI queue",
    "- name: Run AI Triage",
    "- name: Resolve final plan",
    "- name: Run AI review",
    "- name: Recheck review target",
    "- name: Publish PR review",
  ];
  const positions = order.map((value) => workflow.indexOf(value));
  assert.ok(positions.every((value) => value >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right)
  );
  const aiSteps = workflow.slice(
    workflow.indexOf("      - name: Validate AI endpoint access"),
    workflow.indexOf("      - name: Recheck review target")
  );
  const stepCount = (aiSteps.match(/^ {6}- name: /gm) ?? []).length;
  assert.ok(stepCount >= 8);
  assert.equal((aiSteps.match(/continue-on-error: true/g) ?? []).length, stepCount);
  assert.doesNotMatch(aiSteps, /BLOCK_SEVERITY|block_severity/);
  const publishStep = workflow.slice(workflow.indexOf("      - name: Publish PR review"));
  assert.match(
    publishStep,
    /always\(\) && !cancelled\(\) && steps\.recheck\.outputs\.current == 'true'/
  );
  assert.match(publishStep, /publish-pr-review\.ts "\$REPOSITORY" "\$PR_NUMBER" success /);
});

test("a pull request merged while its AI review waited is still reviewed", async () => {
  const review = await text(".github/workflows/handle-pr-review.yml");
  assert.match(
    review,
    /- name: Fetch PR facts[\s\S]*?ALLOW_MERGED_PR: "true"[\s\S]*?resolve-pr-facts\.ts fetch/
  );
  // Only the review opts in: governance still refuses a pull request that is not open.
  assert.doesNotMatch(await text(".github/workflows/handle-pr-dispatch.yml"), /ALLOW_MERGED_PR/);
  const cancel = await text(".github/workflows/cancel-pr-work.yml");
  requireText(cancel, [
    "merged: ${{ steps.closed.outputs.merged }}",
    "if: needs.validate.outputs.merged != 'true'",
  ]);
  assert.match(
    cancel,
    /Cancel PR Review\n\s+needs: validate\n\s+if: needs\.validate\.outputs\.merged/
  );
});

test("task dispatch keeps the publication credential in the central control step", async () => {
  const workflow = await text(".github/workflows/handle-task-dispatch.yml");
  requireText(workflow, [
    "env: ${{ secrets }}",
    "REPOSITORY_VARS_JSON: ${{ toJSON(vars) }}",
    "node scripts/export-repository-variables.ts",
    "node scripts/validate-repository-variables.ts",
    "node scripts/validate-dispatch-payload.ts",
    "compgen -e",
    "action-worker-base-env.names",
    "action-worker-repository-vars.json",
    "AW_REPOSITORY_POLICY",
    "node-version: 24",
    "Checkout task source",
    "repository: ${{ needs.validate.outputs.repository }}",
    "ref: ${{ needs.validate.outputs.bootstrap_ref }}",
    "path: task-source",
    "persist-credentials: false",
    "AW_SOURCE_DIR: ${{ github.workspace }}/task-source",
    'git -C "$AW_SOURCE_DIR" rev-parse HEAD',
    "node scripts/resolve-secret-scope.ts",
    ".secrets.required",
    ".secrets.allowed",
    "Restore previous task state",
    "AW_TASK_STATE_DIR",
    "Upload task state",
    "node scripts/validate-task-publication.ts",
    "Publish staged artifact",
    "secrets.AW_CONTROL_TOKEN",
  ]);
  assert.doesNotMatch(workflow, /toJSON\s*\(\s*secrets\s*\)/);
  const directSecrets = [
    ...workflow.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g),
  ].map((match) => match[1]);
  assert.deepEqual([...new Set(directSecrets)].sort(), ["AW_ARTIFACT_KEY", "AW_CONTROL_TOKEN"]);
  // The task itself never keeps the artifact key: it is checked like the central credentials.
  assert.match(workflow, /for central_name in [A-Z_ ]*AW_ARTIFACT_KEY; do/);
  assert.doesNotMatch(workflow, /AW_EXECUTION_TOKEN|AW_EXECUTION_REPOSITORY/);
  assert.doesNotMatch(workflow, /raw\.githubusercontent\.com|Authorization: Bearer/);
  assert.doesNotMatch(workflow, /scripts\/[A-Za-z0-9-]+\.sh/);

  const publication = await text("scripts/validate-task-publication.ts");
  requireText(publication, [
    "release-source",
    "release-target",
    "action-worker-publication",
    "target_repository",
    "dest_dir",
  ]);
});

test("task publication lands through a governed pull request", async () => {
  const workflow = await text(".github/workflows/handle-task-dispatch.yml");
  requireText(workflow, [
    'branch="task-publication/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    "gh pr create",
    "--base main",
    "chore: ${COMMIT_MESSAGE}",
    "gh pr merge",
    "gh pr update-branch",
    "validate-merge",
    "mergeStateStatus",
  ]);
  assert.doesNotMatch(workflow, /push origin "HEAD:\$branch"/);
  const publication = await text("scripts/validate-task-publication.ts");
  assert.match(
    publication,
    /validateRepositoryCapability\(manifest\.target_repository, policy, "pr"\)/
  );
});

test("task source ingress is source-owned and repository-agnostic", async () => {
  const workflow = await text(".github/workflows/task-source-dispatch.yml");
  requireText(workflow, [
    "workflow_dispatch:",
    "repository:",
    "project:",
    "AW_REPOSITORY_POLICY",
    'repository-policy.ts validate "$repository" task',
    "AW_CONTROL_REPOSITORY",
    "Task Source",
  ]);
  assert.doesNotMatch(
    workflow,
    /fongap-labs\/internal-vault|MarketBrief|PharmaBrief|commits\/main/
  );
  // Scheduled projects are found by Intake; this workflow only handles a request.
  assert.doesNotMatch(workflow, /schedule:|dispatch-scheduled-tasks/);

  const scheduler = await text("scripts/dispatch-scheduled-tasks.ts");
  requireText(scheduler, [
    ".github/task-source.json",
    'repositoriesForCapability(policyValue, "task")',
    "projectsForSchedule",
    "projects/",
    "task.json",
    "run-task",
  ]);
  assert.doesNotMatch(scheduler, /fongap-labs\/internal-vault|MarketBrief|PharmaBrief/);

  const intake = await text("scripts/intake-task-sources.ts");
  requireText(intake, [
    'repositoriesForCapability(policyValue, "task")',
    ".github/task-source.json",
    "manifest.push",
    "Task Source",
    "run-task-source",
  ]);
  assert.doesNotMatch(intake, /fongap-labs\/internal-vault|MarketBrief|PharmaBrief/);

  const intakeWorkflow = await text(".github/workflows/intake.yml");
  requireText(intakeWorkflow, [
    "AW_REPOSITORY_POLICY",
    "AW_CONTROL_TOKEN",
    "intake-task-sources.ts",
    "dispatch-scheduled-tasks.ts",
  ]);
});

test("release, source, deploy, merge, and repository settings contracts remain intact", async () => {
  const releaseBuild = await text(".github/workflows/release-app.yml");
  requireText(releaseBuild, [
    "types: [run-release-build]",
    "workflow_dispatch:",
    "source_repository:",
    "requested_version:",
    "-Version $env:RELEASE_VERSION",
    "resolve-release-build-ingress.ts",
    "steps.ingress.outputs.request_json",
    "validate-release-build-request.ts",
    "package-release-build.ts",
    "$GITHUB_WORKSPACE/source/.github/release.manifest.json",
    "policies/runner.json",
    "fromJSON(matrix.runner_labels_json)",
    "AW_CONTROL_TOKEN",
    "actions/setup-python",
    "actions/setup-node",
    "actions/attest-build-provenance",
    "anchore/sbom-action",
    "run-release",
  ]);
  const releasePackager = await text("scripts/package-release-build.ts");
  requireText(releasePackager, [
    "release-manifest.json",
    "release-provenance.json",
    "artifact_run_id",
    "source_sha",
  ]);
  assert.equal(await exists("policies/release-build.json"), false);
  const releaseBuildValidator = await text("scripts/validate-release-build-request.ts");
  requireText(releaseBuildValidator, [
    ".github/release.manifest.json",
    "parseReleaseBuildManifest",
    "parseRunnerPolicy",
    "resolveRunnerProfile",
    "release-source",
    "release-target",
    "requireVerifiedCiEvidence",
  ]);
  assert.doesNotMatch(
    releaseBuildValidator,
    /repositories\[request\.source_repository\]|fongap-labs\/(?:delta|app-source)/
  );
  // The application version comes only from the version entered when the release is started.
  assert.doesNotMatch(releaseBuildValidator, /version_source|Cargo\.toml|parseCargo/);
  assert.doesNotMatch(await text("contracts/release-build.json"), /version_source/);
  assert.match(releaseBuild, /requested_version:\n\s+description: [^\n]+\n\s+required: true/);

  const release = await text(".github/workflows/handle-release-dispatch.yml");
  requireText(release, [
    "types: [run-release]",
    "source_repository",
    "source_sha",
    "artifact_run_id",
    "AW_CONTROL_TOKEN",
    "node-version: 24",
    "RELEASE_REQUEST_JSON",
    "node scripts/publish-release.ts",
  ]);
  assert.doesNotMatch(release, /AW_RELEASE_(?:SOURCE|TARGET)_ALLOWLIST/);
  const releaseValidator = await text("scripts/validate-release-request.ts");
  requireText(releaseValidator, ["AW_REPOSITORY_POLICY", "release-source", "release-target"]);
  assert.doesNotMatch(
    releaseValidator,
    /AW_(?:PR|EXECUTION|RELEASE_SOURCE|RELEASE_TARGET)_REPOSITORY_ALLOWLIST/
  );
  const prValidator = await text("scripts/validate-pr-payload.ts");
  requireText(prValidator, ["AW_REPOSITORY_POLICY"]);
  assert.doesNotMatch(prValidator, /AW_[A-Z_]*ALLOWLIST/);

  const ciDispatcher = await text("scripts/dispatch-central-ci.ts");
  requireText(ciDispatcher, ["AW_REPOSITORY_POLICY", "validateRepositoryCapability", '"pr"']);
  assert.doesNotMatch(ciDispatcher, /central_repositories|Central CI dispatch skipped/);
  const publisher = await text("scripts/publish-release.ts");
  requireText(publisher, [
    "release-manifest.json",
    "release-provenance.json",
    "artifact_repository",
    "artifact_run_id",
    "return `${releaseKey}-v${version}`",
    "await sha256File(assetPath)",
    "rollbackRelease",
    '"draft=true"',
    '"draft=false"',
    "assertTrustedMainWrite",
    "Main Write Guard",
  ]);
  assert.equal(await exists(".github/workflows/validate-release-policy.yml"), false);
  assert.equal(await exists(".github/workflows/publish-release.yml"), false);

  // Reusable workflows that no repository called any more.
  for (const removed of [
    "validate-central-merge.yml",
    "validate-deploy-policy.yml",
    "validate-source-policy.yml",
  ]) {
    assert.equal(await exists(`.github/workflows/${removed}`), false);
  }

  const merge = await text(".github/actions/validate-merge-policy/action.yml");
  requireText(merge, [
    "ci-result:",
    "head-sha:",
    "require-pr-governance:",
    "PR Governance",
    "Local CI evidence did not pass",
    "PR Governance blocked merge",
  ]);

  const repository = await json("policies/repository.json");
  const rulesetPolicy = await json("policies/rulesets.json");
  const managedRulesets = rulesetPolicy.rulesets as Array<Record<string, unknown>>;
  assert.deepEqual(
    managedRulesets.map((rule) => rule.name),
    ["Protect Main Branch", "Protect Legacy Branches"]
  );
  const mainRules = managedRulesets[0]?.rules as Array<Record<string, unknown>>;
  const statusChecks = mainRules.find((rule) => rule.type === "required_status_checks");
  const statusParameters = statusChecks?.parameters as Record<string, unknown>;
  assert.equal(statusParameters.strict_required_status_checks_policy, true);
  assert.deepEqual(statusParameters.required_status_checks, [{ context: "validate-merge" }]);
  // The ruleset requires one merge gate name. Every workflow that posts the merge gate must post
  // that same name, or the required check never reports and the merge stays blocked.
  for (const workflow of [".github/workflows/handle-pr-dispatch.yml"]) {
    const postedContexts = [...(await text(workflow)).matchAll(/PR_STATUS_CONTEXT: (\S+)/g)].map(
      (match) => match[1]
    );
    assert.ok(postedContexts.length > 0, `${workflow} posts no merge gate status`);
    assert.deepEqual([...new Set(postedContexts)], ["validate-merge"], workflow);
  }
  assert.equal(repository.allow_merge_commit, false);
  assert.equal(repository.allow_squash_merge, true);
  assert.equal(repository.delete_branch_on_merge, true);
  const settings = await text(".github/workflows/apply-repository-settings.yml");
  // The daily run corrects settings changed by hand, so drift never needs a manual run.
  requireText(settings, [
    "secrets.AW_ADMIN_TOKEN",
    "schedule:",
    "group: apply-repository-settings",
    "policies/rulesets.json",
    "scripts/apply-repository-settings.ts",
    "node scripts/apply-repository-settings.ts",
    "node scripts/repository-policy.ts list pr",
  ]);
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
    "pr-review-${{ needs.validate.outputs.repository }}-${{ needs.validate.outputs.pr_number }}",
    "central-ci-${{ needs.validate.outputs.repository }}-${{ needs.validate.outputs.pr_number }}",
    "cancel-in-progress: true",
  ]);
  assert.doesNotMatch(
    workflow,
    /group: (?:pr-governance|pr-review|central-ci)-\$\{\{ github\.event\.client_payload/
  );
  assert.doesNotMatch(
    workflow,
    /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)\|/
  );
});

test("security scanning is source-owned, centrally executed, and private-safe", async () => {
  const workflow = await text(".github/workflows/security-scan-dispatch.yml");
  requireText(workflow, [
    "types: [run-security-scan]",
    "resolve-security-scan.ts",
    "runner_labels_json",
    "github/codeql-action/init@",
    "github/codeql-action/analyze@",
    "upload: never",
    "publish-security-scan.ts",
    "AW_CONTROL_TOKEN",
    "AW_ADMIN_TOKEN",
  ]);
  // CodeQL runs without any secret and hands SARIF to the publish job as a one-day artifact.
  requireText(workflow, [
    "actions/upload-artifact@",
    "actions/download-artifact@",
    "retention-days: 1",
  ]);
  assert.doesNotMatch(
    workflow,
    /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)/
  );

  const dispatcher = await text("scripts/dispatch-security-scan.ts");
  requireText(dispatcher, [
    ".github/security-scan.json",
    "resolveSecurityScanFacts",
    "scanEnabled",
    "private source requires a private-safe executor",
  ]);
  assert.doesNotMatch(
    dispatcher,
    /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)/
  );

  const resolver = await text("scripts/resolve-security-scan.ts");
  requireText(resolver, [
    ".github/security-scan.json",
    "resolveRunnerProfile",
    "sandbox",
    "Private repository CodeQL is not enabled on the public control plane",
  ]);

  const publisher = await text("scripts/publish-security-scan.ts");
  requireText(publisher, [
    "code-scanning/sarifs",
    "gzipSync",
    "commit_sha",
    "processing_status",
    'tool_name: "CodeQL"',
    "AW_ADMIN_TOKEN",
  ]);
  assert.doesNotMatch(publisher, /AW_CONTROL_TOKEN/);
  assert.match(
    workflow,
    /- name: Publish SARIF to target repository[\s\S]*?AW_ADMIN_TOKEN: \$\{\{ secrets\.AW_ADMIN_TOKEN \}\}/
  );

  const intake = await text(".github/workflows/intake.yml");
  const securityScans = intake.slice(intake.indexOf("  security-scans:"));
  requireText(securityScans, [
    "if: github.event.schedule == '17 3 * * 1'",
    "contents: write",
    "intake-security-scans.ts",
    "AW_REPOSITORY_POLICY",
    "AW_CONTROL_TOKEN",
  ]);

  const centralCi = await text(".github/workflows/central-ci-dispatch.yml");
  requireText(centralCi, [
    "Dispatch central security scan",
    "dispatch-security-scan.ts",
    "AW_CONTROL_REPOSITORY",
  ]);
});

test("central CI deploy dispatch is source-owned and adapter-routed", async () => {
  const policy = (await json("policies/deploy.json")) as Record<string, unknown>;
  assert.equal(policy.schema_version, 2);
  assert.equal("repositories" in policy, false);
  const adapters = policy.adapters as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(adapters), ["source-script"]);
  assert.deepEqual(adapters["source-script"], { event_type: "run-source-script-deploy" });

  const manifestResolver = await text("scripts/deploy-manifest.ts");
  requireText(manifestResolver, [
    ".github/deploy.json",
    "validateRepositoryCapability",
    "resolveRunnerProfile",
  ]);

  const dispatcher = await text("scripts/dispatch-central-deploy.ts");
  requireText(dispatcher, [
    "resolveDeployManifest",
    "AW_REPOSITORY_POLICY",
    "policies/runner.json",
    "manifest.automatic",
    "manifest.ignore_docs_only",
    "manifest.adapter",
  ]);
  assert.doesNotMatch(
    dispatcher,
    /policy\.repositories|fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)/
  );

  const workflow =
    (await text(".github/workflows/central-ci-dispatch.yml")) +
    (await text(".github/workflows/central-ci-sandbox.yml"));
  requireText(workflow, [
    "Central CI / Security",
    "validate-security.ts",
    "SECURITY_RESULT",
    '[[ "$SECURITY_RESULT" == "success" ]]',
    "needs.finalize.result == 'success'",
    "Attest deploy source main write",
    "MAIN_WRITE_AUDIT_REPOSITORY: ${{ needs.prepare.outputs.repository }}",
    "MAIN_WRITE_AUDIT_RUN_URL",
    "audit-main-writes.ts",
    "Dispatch automatic deploy",
    "dispatch-central-deploy.ts",
    "policies/deploy.json",
    "policies/runner.json",
    "needs.prepare.outputs.pr_number == '0'",
    // A failed security scan dispatch must not silently skip the main write attestation and the
    // deploy, and an untrusted main write must never be deployed.
    "if: ${{ !cancelled() && needs.prepare.outputs.pr_number == '0' }}",
    "if: ${{ !cancelled() && steps.deploy_control.outcome == 'success' }}",
    "if: ${{ !cancelled() && steps.attest.outcome == 'success' }}",
    "contents: write",
    "AW_REPOSITORY_POLICY",
    'repository-policy.ts validate "$REPOSITORY" pr',
    'resolve-ci-capabilities.ts "$REPOSITORY" "$CONTROL_REF"',
    "Resolve PR CI control",
    "resolve-ci-control-ref.ts",
    "steps.ci_control.outputs.control_ref",
    "candidate_control",
    "needs.prepare.outputs.has_windows == 'true'",
    "CENTRAL_CI_FAILURE_FILE",
    "BASH_ENV",
    "Trusted CI failed at line",
    "Detailed output is suppressed because the target repository is private.",
  ]);
  assert.doesNotMatch(workflow, /BASH_COMMAND|tail -n|cat "\$failure_meta"/);
  assert.doesNotMatch(
    workflow,
    /case "\$REPOSITORY"|needs\.prepare\.outputs\.repository == 'fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)'|fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)\|/
  );
  assert.match(workflow, /context=CI Evidence/);
  assert.doesNotMatch(workflow, /ci-evidence/);
});

test("source-script deploy execution is manifest-driven and repository-agnostic", async () => {
  const workflow = await text(".github/workflows/deploy-source-script.yml");
  requireText(workflow, [
    "types: [run-source-script-deploy]",
    "workflow_dispatch:",
    "source_repository:",
    "source_sha:",
    "validate-deploy-source.ts source-script true policies/runner.json",
    "AW_REPOSITORY_POLICY",
    "runner_labels_json",
    "fromJSON(needs.prepare.outputs.runner_labels_json)",
    "environment: ${{ needs.prepare.outputs.environment }}",
    "DEPLOY_SOURCE_REPOSITORY",
    "DEPLOY_SOURCE_SHA",
    "DEPLOY_ENVIRONMENT",
    "DEPLOY_ENTRYPOINT",
    "REPOSITORY_VARS_JSON: ${{ toJSON(vars) }}",
    "resolve-secret-scope.ts",
    "deploy.secrets.required",
    "deploy.secrets.allowed",
    "for central_name in AW_CONTROL_TOKEN AW_ADMIN_TOKEN AW_DISPATCH_TOKEN",
    "Execute source-owned deploy entrypoint",
  ]);
  assert.doesNotMatch(workflow, /for central_name in[^\n]*AIG_ACCESS_KEY_AGENT/);
  assert.doesNotMatch(
    workflow,
    /SERVER_EDGE_|fongap-labs\/internal-vault|tailscale\/github-action/
  );
  assert.doesNotMatch(workflow, /toJSON\s*\(\s*secrets\s*\)/);
  assert.equal(workflow.includes("schedule:"), false);

  const policy = (await json("policies/deploy.json")) as {
    schema_version: number;
    adapters: Record<string, { event_type: string }>;
  };
  assert.deepEqual(policy, {
    schema_version: 2,
    adapters: {
      "source-script": { event_type: "run-source-script-deploy" },
    },
  });
  const manifestContract = await text("contracts/deploy-manifest.json");
  assert.doesNotMatch(manifestContract, /cloudflare-worker/);
  assert.equal(await exists(".github/workflows/aig-deploy.yml"), false);
  assert.equal(await exists(".github/workflows/model-discovery.yml"), false);
  assert.equal(await exists("tests/aig-deploy.test.ts"), false);
});

test("tool distribution sync runs only in the central control plane", async () => {
  const workflow = await text(".github/workflows/release-tool.yml");
  requireText(workflow, [
    "schedule:",
    "sync-tool-release.ts",
    "AW_CONTROL_TOKEN",
    "run-release",
    'schema_version: "2"',
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
    "parseUrlToolMetadata",
  ]);
});

test("self CI requires deterministic security checks", async () => {
  const workflow = await text(".github/workflows/validate-ci.yml");
  requireText(workflow, [
    "Security checks",
    "validate-security.ts",
    "SECURITY_RESULT",
    "validate-naming-rules.ts",
    "actionlint",
    "node-version: 24",
    "npm run typecheck",
    "npm test",
    "validate-merge",
  ]);
  assert.doesNotMatch(workflow, /shellcheck|tests\/test-[A-Za-z0-9-]+\.sh/);
  // Only a superseded pull request head is cancelled; a push to main always keeps its validation.
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("metrics workflow delegates branch and PR orchestration to TypeScript", async () => {
  const workflow = await text(".github/workflows/update-work-metrics.yml");
  for (const stage of ["increment", "changes", "branch", "pull", "cleanup", "ci", "merge"]) {
    assert.ok(workflow.includes(`node scripts/manage-work-metrics.ts ${stage}`));
  }
  assert.doesNotMatch(workflow, /shell:\s+bash|run:\s*\|/);
  assert.match(workflow, /METRICS_TOKEN:.*AW_CONTROL_TOKEN/);
  assert.equal((workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length, 2);
  assert.equal(
    (workflow.match(/GH_TOKEN: \$\{\{ secrets\.AW_CONTROL_TOKEN \}\}/g) ?? []).length,
    4
  );
  assert.match(workflow, /GIT_PUSH_TOKEN: \$\{\{ secrets\.AW_CONTROL_TOKEN \}\}/);
  const pullStep = workflow.slice(
    workflow.indexOf("      - name: Create auto-update PR"),
    workflow.indexOf("      - name: Wait for CI")
  );
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
  assert.match(metricsScript, /"api",\s*"--method",\s*"GET",\s*`repos\/\$\{repository\}\/pulls`/);
  assert.match(workflow, /node scripts\/repository-policy\.ts list pr/);
});

test("main write guard is the post-merge provenance authority", async () => {
  const workflow = await text(".github/workflows/main-write-guard.yml");
  // The workflow guards Action Worker's own main with the workflow token; managed repositories are
  // attested by audit-main-writes.ts, so nothing here needs the control token.
  requireText(workflow, [
    "push:",
    "branches: [main]",
    "Main Write Guard",
    'MAIN_WRITE_REQUIRE_CENTRAL_STATUSES: "false"',
    "MAIN_WRITE_TOKEN: ${{ github.token }}",
    "node scripts/main-write-guard.ts",
  ]);
  assert.doesNotMatch(workflow, /repository_dispatch|secrets\./);
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
  const intake = await text(".github/workflows/intake.yml");
  const workflow = intake.slice(
    intake.indexOf("  main-writes:"),
    intake.indexOf("  task-sources:")
  );
  requireText(workflow, [
    "AW_CONTROL_TOKEN",
    "AW_REPOSITORY_POLICY",
    "node scripts/audit-main-writes.ts",
  ]);
  assert.match(intake, /cron: "\*\/5 \* \* \* \*"/);
  const script = await text("scripts/audit-main-writes.ts");
  requireText(script, [
    'repositoriesForCapability(policy, "pr")',
    "validateMainWriteProvenance",
    "Main Write Guard",
    "commits/main",
    "repository !== controlRepository",
    "GITHUB_REPOSITORY",
  ]);
  assert.doesNotMatch(
    workflow,
    /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)/
  );
  assert.doesNotMatch(
    script,
    /fongap-labs\/(?:ai-gateway|delta|delta-suite|app-source|internal-vault|external-vault)/
  );
});

test("dependency repair keeps compute and publication authority separated", async () => {
  const workflow = await text(".github/workflows/dependency-repair-dispatch.yml");
  requireText(workflow, [
    "types: [run-dependency-repair]",
    "resolve-dependency-repair.ts",
    "collect-dependency-repair.ts",
    "publish-dependency-repair.ts",
    "persist-credentials: false",
    "needs.compute.outputs.changed == 'true'",
    "AW_REPOSITORY_POLICY",
    "AW_CONTROL_TOKEN",
  ]);
  assert.doesNotMatch(workflow, /fongap-labs\/delta|pyproject\.toml|uv\.lock/);

  const resolver = await text("scripts/resolve-dependency-repair.ts");
  requireText(resolver, [
    ".github/dependency-repair.json",
    "validateRepositoryCapability",
    "resolveRunnerProfile",
    "sandbox",
  ]);
  assert.doesNotMatch(resolver, /fongap-labs\/delta/);

  const publisher = await text("scripts/publish-dependency-repair.ts");
  requireText(publisher, ["resolveDependencyRepairFacts", "selectDependencyRepair", "git", "push"]);
  assert.doesNotMatch(publisher, /fongap-labs\/delta/);
});

test("PR governance enforces trust before it dispatches central CI", async () => {
  const workflow = await text(".github/workflows/handle-pr-dispatch.yml");
  assert.match(
    workflow,
    /- name: Enforce PR trust[\s\S]*?node scripts\/pr-trust\.ts "\$REPOSITORY" "\$PR_NUMBER" "\$HEAD_SHA"\n\n\s+- name: Dispatch centralized CI/
  );
});

test("deploy and task entrypoints replace the shell that received every secret", async () => {
  const deploy = await text(".github/workflows/deploy-source-script.yml");
  assert.match(deploy, /\n\s+exec bash "\$DEPLOY_ENTRYPOINT"\n/);
  assert.doesNotMatch(deploy, /\n\s+bash "\$DEPLOY_ENTRYPOINT"\n/);

  const task = await text(".github/workflows/handle-task-dispatch.yml");
  assert.match(task, /exec bash "\$TMP_SCRIPT" "\$PROJECT" "\$BOOTSTRAP_REF" "\$REQUEST_ID"\n/);
  assert.doesNotMatch(task, /\n\s+bash "\$TMP_SCRIPT"/);
  // Private task output stays out of this public repository's run logs.
  requireText(task, [
    "is_private: ${{ steps.visibility.outputs.is_private }}",
    "TASK_SOURCE_PRIVATE: ${{ needs.validate.outputs.is_private }}",
    '>"${RUNNER_TEMP}/action-worker-task.log" 2>&1',
    "Task output is suppressed because the task source repository is private.",
  ]);
  // Artifacts of this public repository are downloadable by any signed-in user: the plain log is
  // never uploaded, only the sealed copy, and only for a failed private task.
  assert.doesNotMatch(task, /path: .*action-worker-task\.log/);
  assert.match(
    task,
    /- name: Seal failed private task log\n\s+id: task_log\n\s+if: always\(\) && steps\.task\.outcome == 'failure' && env\.TASK_SOURCE_PRIVATE != 'false'\n/
  );
  assert.match(
    task,
    /- name: Upload sealed task log\n\s+if: always\(\) && steps\.task_log\.outputs\.path != ''[\s\S]*?path: \$\{\{ steps\.task_log\.outputs\.path \}\}/
  );
  assert.ok(
    task.indexOf("- name: Seal failed private task log") <
      task.indexOf("- name: Report task result"),
    "the log is sealed before the report step deletes it"
  );
  assert.match(
    task,
    /- name: Upload task state\n\s+if: always\(\) && steps\.state_upload\.outputs\.path != ''[\s\S]*?path: \$\{\{ steps\.state_upload\.outputs\.path \}\}/
  );
});

test("only PR Governance reports an untrusted head instead of failing", async () => {
  const { AWAITING_APPROVAL_DESCRIPTION } = await import("../scripts/pr-trust.ts");
  const governance = await text(".github/workflows/handle-pr-dispatch.yml");
  assert.match(
    governance,
    /- name: Enforce PR trust\n\s+id: trust\n\s+env:\n\s+PR_TRUST_UNTRUSTED: report\n/
  );
  assert.equal(governance.split(`'${AWAITING_APPROVAL_DESCRIPTION}'`).length - 1, 2);
  for (const step of ["Dispatch centralized CI", "Collect CI evidence", "Validate CI evidence"]) {
    assert.ok(
      governance.includes(`- name: ${step}\n        if: steps.trust.outputs.trusted == 'true' && `),
      `${step} runs only for a trusted head`
    );
  }
  assert.match(
    governance,
    /- name: Mark deterministic gate passed\n\s+id: gate\n\s+if: steps\.trust\.outputs\.trusted == 'true'\n/
  );

  // The Central CI that executes change code keeps failing closed on an untrusted head.
  const centralCi = await text(".github/workflows/central-ci-dispatch.yml");
  assert.doesNotMatch(centralCi, /PR_TRUST_UNTRUSTED/);
});

test("Central CI follow-ups cannot fail the run that carries CI Evidence", async () => {
  const workflow = await text(".github/workflows/central-ci-dispatch.yml");
  const finalize = workflow.slice(
    workflow.indexOf("  finalize:"),
    workflow.indexOf("  follow-up:")
  );
  const followUp = workflow.slice(workflow.indexOf("  follow-up:"));
  assert.match(finalize, /context=CI Evidence/);
  assert.doesNotMatch(finalize, /dispatch-security-scan|dispatch-central-deploy|audit-main-writes/);
  requireText(followUp, [
    "if: always() && needs.finalize.result == 'success'",
    "continue-on-error: true",
    "dispatch-security-scan.ts",
    "audit-main-writes.ts",
    "dispatch-central-deploy.ts",
  ]);
});

test("manual release, deploy and task entry points request central CI and explain bad input", async () => {
  const release = await text(".github/workflows/release-app.yml");
  const deploy = await text(".github/workflows/deploy-source-script.yml");
  const task = await text(".github/workflows/task-source-dispatch.yml");
  // Intake may not have reached the source yet, so each entry asks for CI and attests the main
  // write itself. The attestation never blocks: the gate after it stays the authority, and a
  // failed task source run would make Intake retry the same SHA on every heartbeat.
  for (const workflow of [release, deploy, task]) {
    requireText(workflow, [
      "- name: Request central CI for the source",
      "AW_CI_INTAKE_REPOSITORY:",
      "node scripts/intake-main-ci.ts",
      "- name: Attest the source main write",
      "MAIN_WRITE_AUDIT_REPOSITORY:",
      "node scripts/audit-main-writes.ts",
    ]);
    const attest = workflow.slice(workflow.indexOf("- name: Attest the source main write"));
    assert.match(attest, /^[^\n]*\n(?:\s+if: [^\n]+\n)?\s+continue-on-error: true\n/);
  }
  for (const [workflow, gate] of [
    [release, "- name: Validate release build request"],
    [deploy, "- name: Validate deploy source"],
    [task, "- name: Dispatch selected tasks"],
  ] as const) {
    assert.ok(
      workflow.indexOf("- name: Request central CI for the source") <
        workflow.indexOf("- name: Attest the source main write")
    );
    assert.ok(workflow.indexOf("- name: Attest the source main write") < workflow.indexOf(gate));
  }
  // The validation waits for the verdict for up to 20 minutes, so the job must outlive the wait.
  assert.match(release, /prepare:[\s\S]*?timeout-minutes: 30/);
  assert.match(deploy, /prepare:[\s\S]*?timeout-minutes: 30/);
  // A bad manual deploy input is named, never a silent exit; an empty SHA means the current HEAD.
  requireText(deploy, [
    'node scripts/repository-policy.ts validate "$SOURCE_REPOSITORY" deploy',
    "source_sha must be a full 40-character lowercase commit SHA",
  ]);
  assert.doesNotMatch(deploy, /\[\[ "\$SOURCE_SHA" =~ [^\n]*\]\]\n/);
  assert.match(deploy, /source_sha:\n\s+description: [^\n]+\n\s+required: false/);
});
