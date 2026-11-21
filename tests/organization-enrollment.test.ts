import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import {
  addOnboardingChangelog,
  formatOnboardingPolicy,
  type InstalledRepo,
  planOnboarding,
  safeOnboardingOnly,
} from "../scripts/enroll-organization-repositories.ts";

const policy = {
  schema_version: 1,
  organization: "fongap-labs",
  auto_enroll_created_after: "2026-11-07T00:00:00Z",
  excluded_repositories: ["fongap-labs/retired-fixture"],
  grants: {
    "fongap-labs/action-worker": ["pr", "task"],
    "fongap-labs/ai-gateway": ["pr", "task", "deploy"],
  },
};

function repo(name: string, overrides: Partial<InstalledRepo> = {}): InstalledRepo {
  return {
    full_name: `fongap-labs/${name}`,
    owner: { login: "fongap-labs" },
    default_branch: "main",
    created_at: "2026-11-08T00:00:00Z",
    archived: false,
    ...overrides,
  };
}

test("new App-visible repositories get only PR, never task, release, or deploy", () => {
  const next = planOnboarding(policy, [
    repo("action-worker", { created_at: "2025-01-01T00:00:00Z" }),
    repo("ai-gateway", { created_at: "2025-01-01T00:00:00Z" }),
    repo("new-service"),
    repo("another"),
  ]);
  assert.deepEqual(next.grants["fongap-labs/action-worker"], ["pr", "task"]);
  assert.deepEqual(next.grants["fongap-labs/ai-gateway"], ["pr", "task", "deploy"]);
  assert.deepEqual(next.grants["fongap-labs/new-service"], ["pr"]);
  assert.deepEqual(next.grants["fongap-labs/another"], ["pr"]);
  assert.deepEqual(planOnboarding(next, [repo("new-service")]), next);
  assert.equal(safeOnboardingOnly(policy, next, [repo("new-service"), repo("another")]), true);
});

test("all active main repositories are enrolled regardless of age; explicit exclusions remain respected", () => {
  const result = planOnboarding(policy, [
    repo("retired-fixture"),
    repo("old", { created_at: "2026-11-06T00:00:00Z" }),
    repo("archive", { archived: true }),
    repo("disabled", { disabled: true }),
    repo("fork", { fork: true }),
    repo("master", { default_branch: "master" }),
    repo("missing-created", { created_at: "" }),
  ]);
  assert.deepEqual(result.grants["fongap-labs/old"], ["pr"]);
  assert.deepEqual(result.grants["fongap-labs/missing-created"], ["pr"]);
  assert.equal(result.grants["fongap-labs/retired-fixture"], undefined);
  for (const name of ["archive", "disabled", "fork", "master"]) {
    assert.equal(result.grants["fongap-labs/" + name], undefined);
  }
});

test("untrusted inventory and unexpected privilege changes fail closed", () => {
  assert.throws(() => planOnboarding(policy, [repo("repeat"), repo("repeat")]));
  assert.throws(() => planOnboarding(policy, [{ ...repo("wrong"), full_name: "outside/wrong" }]));
  assert.throws(() => planOnboarding({ ...policy, grants: { "outside/repo": ["pr"] } }, []));
  assert.throws(
    () =>
      planOnboarding(
        {
          ...policy,
          grants: { ...policy.grants, "fongap-labs/retired-fixture": ["pr"] },
        },
        []
      ),
    /Excluded repository must not retain a governance grant/
  );

  const inventory = [repo("new-service")];
  const candidate = planOnboarding(policy, inventory);
  const escalated = {
    ...candidate,
    grants: { ...candidate.grants, "fongap-labs/new-service": ["pr", "deploy"] },
  };
  assert.equal(safeOnboardingOnly(policy, escalated, inventory), false);
  const alteredOriginal = {
    ...candidate,
    grants: { ...candidate.grants, "fongap-labs/ai-gateway": ["pr", "task"] },
  };
  assert.equal(safeOnboardingOnly(policy, alteredOriginal, inventory), false);
  assert.equal(safeOnboardingOnly(policy, candidate, []), false);
});

test("auto-enrollment creates a formatter-compliant policy and a scoped Chinese changelog entry", () => {
  const next = planOnboarding(policy, [repo("new-service")]);
  const formatted = formatOnboardingPolicy(next);
  assert.deepEqual(JSON.parse(formatted), next);
  assert.match(formatted, /"fongap-labs\/new-service": \["pr"\]/);
  const base = "# 更新日志\n\n## [Unreleased]\n\n- 维护: 已有内容。\n";
  const updated = addOnboardingChangelog(base, ["fongap-labs/new-service"]);
  assert.ok(updated.includes("- 维护: 自动将 fongap-labs/new-service 纳入中央 PR 治理"));
  assert.ok(updated.includes("- 维护: 已有内容。"));
  assert.throws(() => addOnboardingChangelog(updated, ["fongap-labs/new-service"]));
  assert.throws(() => addOnboardingChangelog(base, []));
});

test("organization enrollment only resumes from successful in-repository onboarding PR CI", async () => {
  const content = await readFile(".github/workflows/enroll-organization-repositories.yml", "utf8");
  const workflow = parse(content) as {
    on: {
      workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] };
      push?: { branches?: string[] };
      schedule?: Array<{ cron: string }>;
    };
    jobs: { onboard?: { if?: string } };
  };
  const script = await readFile("scripts/enroll-organization-repositories.ts", "utf8");
  const onboardingBranch = /const branchName = "([^"]+)";/.exec(script)?.[1];
  assert.ok(onboardingBranch, "the controlled onboarding branch must be declared");
  assert.deepEqual(workflow.on.workflow_run?.branches, [onboardingBranch]);
  assert.deepEqual(workflow.on.workflow_run?.types, ["completed"]);
  assert.deepEqual(workflow.on.push?.branches, ["main"]);
  assert.ok(workflow.on.schedule?.length, "scheduled inventory reconciliation remains enabled");

  const condition = workflow.jobs.onboard?.if ?? "";
  assert.match(condition, /github\.event_name != 'workflow_run'/);
  assert.match(condition, /github\.event\.workflow_run\.event == 'pull_request'/);
  assert.match(condition, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(
    condition,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/
  );
});

test("automatic enrollment uses one versioned policy and the existing hard merge gate", async () => {
  const workflow = await readFile(".github/workflows/enroll-organization-repositories.yml", "utf8");
  const script = await readFile("scripts/enroll-organization-repositories.ts", "utf8");
  assert.match(workflow, /environment:\s*\n\s*name: admin-ops\s*\n\s*deployment: false/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /permission-contents: read/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.match(workflow, /permission-contents: write/);
  assert.doesNotMatch(workflow, /AW_REPOSITORY_POLICY|continue-on-error: true/);
  assert.match(script, /safeOnboardingOnly\(base, candidate.value, inventory\)/);
  assert.match(script, /check.conclusion === "success"/);
  assert.match(script, /check.app\?\.id === 15368/);
  assert.match(script, /merge_method: "squash"/);
  assert.match(script, /files.length !== 2/);
  assert.match(script, /actualChangelog.content !== expectedChangelog/);
  assert.match(script, /formatOnboardingPolicy\(next\)/);
  assert.doesNotMatch(script, /AW_ADMIN_TOKEN|bypass_actors|main\.write/);
});
