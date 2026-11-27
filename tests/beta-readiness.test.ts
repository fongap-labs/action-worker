import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  auditBetaDeployReadiness,
  planBetaReleaseReadiness,
} from "../scripts/audit-beta-readiness.ts";
import { formalTagProtection } from "../scripts/beta-release-authorization.ts";

const repository = "fongap-labs/example";
const control = "fongap-labs/action-worker";
const grants = { [repository]: ["pr", "release-source", "release-target", "deploy"] };
const policy = { schema_version: 1, mode: "prepare" };
const repo = { full_name: repository, private: false, default_branch: "main" };
const rule = formalTagProtection(policy, repository, grants, control);
const prefix = `repos/${control}/environments/beta-example-ops`;
const target = {
  credential_environment: "beta-example-ops",
  credentials: {
    API_TOKEN: { source: "BETA_EXAMPLE_OPS_API_TOKEN", kind: "secret" },
    ACCOUNT: { source: "BETA_EXAMPLE_OPS_ACCOUNT", kind: "variable" },
  },
};
const routes: Record<string, unknown> = {
  [`repos/${repository}`]: repo,
  [`repos/${repository}/rulesets?includes_parents=false&per_page=100`]: [
    { id: 42, name: "Protect Formal Tags" },
  ],
  [`repos/${repository}/rulesets/42?includes_parents=false`]: rule,
  [prefix]: {
    name: "beta-example-ops",
    protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
  },
  [`${prefix}/secrets?per_page=100&page=1`]: {
    secrets: [{ name: "BETA_EXAMPLE_OPS_API_TOKEN" }],
  },
  [`${prefix}/variables?per_page=100&page=1`]: {
    variables: [{ name: "BETA_EXAMPLE_OPS_ACCOUNT", value: "not-reported" }],
  },
};

function reader(overrides: Record<string, unknown> = {}) {
  const responses = { ...routes, ...overrides };
  return {
    async get(path: string): Promise<unknown> {
      assert.ok(Object.hasOwn(responses, path), path);
      return responses[path];
    },
  };
}

test("release readiness requires both live formal tag isolation and independent App setup", async () => {
  assert.deepEqual(
    await planBetaReleaseReadiness(reader(), repository, control, grants, policy, true),
    { probe: true }
  );
  const missing = await planBetaReleaseReadiness(
    reader(),
    repository,
    control,
    grants,
    policy,
    false
  );
  assert.equal(missing.result?.ready, false);
  const drift = reader({ [`repos/${repository}/rulesets/42?includes_parents=false`]: {} });
  assert.equal(
    (await planBetaReleaseReadiness(drift, repository, control, grants, policy, true)).probe,
    false
  );
  assert.deepEqual(
    await planBetaReleaseReadiness(
      reader(),
      repository,
      control,
      grants,
      { schema_version: 1, mode: "closed" },
      true
    ),
    { probe: false }
  );
});

test("deploy inventory verifies exact dedicated Environment names without reporting values", async () => {
  const deployment = { schema_version: 1, targets: { [repository]: target } };
  const ready = await auditBetaDeployReadiness(reader(), control, grants, deployment);
  assert.equal(ready[0]?.ready, true);
  assert.doesNotMatch(JSON.stringify(ready), /not-reported|API_TOKEN|ACCOUNT/);
  const missing = reader({ [`${prefix}/secrets?per_page=100&page=1`]: { secrets: [] } });
  assert.equal(
    (await auditBetaDeployReadiness(missing, control, grants, deployment))[0]?.ready,
    false
  );
  const unprotected = reader({ [prefix]: { name: "beta-example-ops", protection_rules: [] } });
  assert.equal(
    (await auditBetaDeployReadiness(unprotected, control, grants, deployment))[0]?.ready,
    false
  );
  assert.deepEqual(
    await auditBetaDeployReadiness(reader(), control, grants, { schema_version: 1, targets: {} }),
    []
  );
});

test("readiness is part of the existing protected settings workflow, not a publication job", () => {
  const workflow = parse(readFileSync(".github/workflows/apply-repository-settings.yml", "utf8"));
  const managed = workflow.jobs["apply-managed"];
  assert.equal(managed.environment.name, "admin-ops");
  const plan = managed.steps.find((step: { id?: string }) => step.id === "beta_plan");
  const probe = managed.steps.find((step: { id?: string }) => step.id === "beta_probe");
  assert.equal(plan.if, "github.event_name != 'workflow_run'");
  assert.equal(probe.if, "steps.beta_plan.outputs.probe == 'true'");
  assert.equal(probe.with.repositories, "${{ steps.beta_plan.outputs.repository_name }}");
  assert.equal(probe.with["permission-contents"], "write");
  assert.equal(probe.with["client-id"], "${{ vars.AW_BETA_RELEASE_APP_CLIENT_ID }}");
  assert.equal(probe.with["private-key"], "${{ secrets.AW_BETA_RELEASE_APP_PRIVATE_KEY }}");
  assert.match(JSON.stringify(workflow.jobs["apply-control-plane"]), /audit-beta-readiness.ts deploy/);
});
