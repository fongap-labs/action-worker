import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  type InstalledRepo,
  planOnboarding,
  safeOnboardingOnly,
} from "../scripts/enroll-organization-repositories.ts";

const policy = {
  schema_version: 1,
  organization: "fongap-labs",
  auto_enroll_created_after: "2026-11-07T00:00:00Z",
  excluded_repositories: ["fongap-labs/delta-legacy"],
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

test("legacy, archived, disabled, fork, and non-main repositories are not automatically granted", () => {
  const result = planOnboarding(policy, [
    repo("delta-legacy"),
    repo("old", { created_at: "2026-11-06T00:00:00Z" }),
    repo("archive", { archived: true }),
    repo("disabled", { disabled: true }),
    repo("fork", { fork: true }),
    repo("master", { default_branch: "master" }),
    repo("missing-created", { created_at: "" }),
  ]);
  assert.deepEqual(result.grants, policy.grants);
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
          grants: { ...policy.grants, "fongap-labs/delta-legacy": ["pr"] },
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
  assert.doesNotMatch(script, /AW_ADMIN_TOKEN|bypass_actors|main\.write/);
});
