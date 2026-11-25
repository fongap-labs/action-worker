import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBetaProducer,
  betaReleaseEnabled,
  protectsFormalTags,
  readBetaReleasePolicy,
  verifyBetaReleaseSource,
} from "../scripts/beta-release-authorization.ts";

const repository = "fongap-labs/example";
const control = "fongap-labs/action-worker";

test("Beta publication is disabled by default before any source reads", async () => {
  assert.equal(betaReleaseEnabled(readBetaReleasePolicy(), repository), false);
  await assert.rejects(
    verifyBetaReleaseSource(
      {
        async get() {
          return assert.fail("disabled policy must not read target");
        },
      },
      repository,
      "a".repeat(40),
      control,
      readBetaReleasePolicy()
    ),
    /disabled/
  );
});

test("Beta producer must be the exact completed central manual build", () => {
  const request = {
    source_repository: repository,
    source_branch: "dev",
    artifact_repository: control,
    artifact_run_id: 123,
    request_id: "release-build-123-1",
  };
  const run = {
    id: 123,
    repository: { full_name: control },
    path: ".github/workflows/release-app.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  assert.doesNotThrow(() => assertBetaProducer(request, run, control));
  for (const invalid of [
    { head_branch: "dev" },
    { run_attempt: 2 },
    { path: ".github/workflows/ci.yml" },
    { event: "repository_dispatch" },
    { conclusion: "failure" },
  ]) {
    assert.throws(() => assertBetaProducer(request, { ...run, ...invalid }, control));
  }
});

test("formal tag protection permits only the formal App to bypass", () => {
  const rule = {
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/**"], exclude: ["refs/tags/*-v*-beta.*"] } },
    bypass_actors: [{ actor_type: "Integration", actor_id: 5609149, bypass_mode: "always" }],
    rules: ["creation", "update", "deletion"].map((type) => ({ type })),
  };
  assert.equal(protectsFormalTags(rule), true);
  assert.equal(protectsFormalTags({ ...rule, enforcement: "disabled" }), false);
  assert.equal(protectsFormalTags({ ...rule, bypass_actors: [] }), false);
  assert.equal(protectsFormalTags({ ...rule, rules: rule.rules.slice(1) }), false);
});
