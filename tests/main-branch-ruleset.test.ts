import assert from "node:assert/strict";
import test from "node:test";
import { managedRepositories, rulesetPayload } from "../scripts/apply-main-branch-ruleset.ts";

test("main branch ruleset policy strips control metadata from API payload", () => {
  const policy = {
    schema_version: 1,
    repositories: ["fongap-labs/ai-gateway", "fongap-labs/delta"],
    name: "Protect Main Branch",
    target: "branch",
    enforcement: "active",
    rules: [],
  };
  assert.deepEqual(managedRepositories(policy), [
    "fongap-labs/ai-gateway",
    "fongap-labs/delta",
  ]);
  assert.deepEqual(rulesetPayload(policy), {
    name: "Protect Main Branch",
    target: "branch",
    enforcement: "active",
    rules: [],
  });
});

test("main branch ruleset rejects duplicate or invalid repository identities", () => {
  assert.throws(() => managedRepositories({
    repositories: ["fongap-labs/delta", "fongap-labs/delta"],
  }));
  assert.throws(() => managedRepositories({
    repositories: ["not a repository"],
  }));
});
