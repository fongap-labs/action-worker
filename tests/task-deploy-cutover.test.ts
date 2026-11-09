import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertTaskExecutionAllowed,
  validateDispatch,
} from "../scripts/validate-dispatch-payload.ts";

const policy = JSON.parse(readFileSync("policies/task-execution-modes.json", "utf8"));

test("a retired source task cannot be reactivated using an old pinned commit", () => {
  for (const sha of ["a".repeat(40), "f".repeat(40)]) {
    assert.deepEqual(
      validateDispatch({
        schema_version: "1",
        request_id: "legacy-task-replay",
        repository: "fongap-labs/internal-vault",
        project: "FongapCDN",
        bootstrap_ref: sha,
      }),
      { agent_domain: "coding", operation: "task" }
    );
    assert.throws(
      () => assertTaskExecutionAllowed(policy, "fongap-labs/internal-vault", "FongapCDN"),
      /generic Task Dispatch is disabled/
    );
  }
  // Other authorized task projects in the same private source are unaffected.
  assert.doesNotThrow(() =>
    assertTaskExecutionAllowed(policy, "fongap-labs/internal-vault", "MarketBrief")
  );
  assert.doesNotThrow(() => assertTaskExecutionAllowed(policy, "fongap-labs/other", "FongapCDN"));
});

test("the cutover deny entry has an independent centrally approved deployment", () => {
  const routes = JSON.parse(readFileSync("policies/deploy-credential-environments.json", "utf8"));
  const environments = JSON.parse(readFileSync("policies/deploy-environments.json", "utf8"));
  for (const key of policy.deploy_only as string[]) {
    assert.ok(environments.repositories[key]?.includes("production"));
    assert.equal(routes.routes[key]?.production, "internal-vault-ops");
  }
});

test("deploy-only cutover revokes generic task credential grants without affecting other projects", () => {
  const taskSecrets = JSON.parse(readFileSync("policies/task-secrets.json", "utf8"));
  const deploySecrets = JSON.parse(readFileSync("policies/deploy-secrets.json", "utf8"));
  for (const key of policy.deploy_only as string[]) {
    const parts = key.split("/");
    const project = parts.pop()!;
    const source = parts.join("/");
    assert.equal(
      taskSecrets.tasks[source]?.[project],
      undefined,
      `Deploy-only project must not retain task credential grants: ${key}`
    );
    assert.ok(deploySecrets.deployments[key], `Deploy-only project needs deploy bindings: ${key}`);
  }
  assert.ok(taskSecrets.tasks["fongap-labs/internal-vault"]?.EngineSuite);
  assert.ok(taskSecrets.tasks["fongap-labs/internal-vault"]?.MarketBrief);
});

test("invalid or duplicate task mode policies fail closed", () => {
  for (const value of [
    null,
    {},
    { schema_version: 2, deploy_only: [] },
    { schema_version: 1, deploy_only: "anything" },
    { schema_version: 1, deploy_only: ["../oops"] },
    { schema_version: 1, deploy_only: ["org/repo/demo", "org/repo/demo"] },
    { schema_version: 1, deploy_only: [], permissive: true },
  ]) {
    assert.throws(() => assertTaskExecutionAllowed(value, "org/repo", "demo"), /policy is invalid/);
  }
});
