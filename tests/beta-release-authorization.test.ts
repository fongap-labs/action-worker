import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBetaProducer,
  betaReleaseCandidate,
  betaReleaseEnabled,
  formalTagProtection,
  protectsFormalTags,
  readBetaReleasePolicy,
  verifyBetaReleaseSource,
} from "../scripts/beta-release-authorization.ts";

const repository = "fongap-labs/example";
const control = "fongap-labs/action-worker";
const grants = { [repository]: ["pr", "release-source", "release-target"] };

test("Beta publication uses existing grants; closed policy denies before source reads", async () => {
  assert.equal(betaReleaseEnabled(readBetaReleasePolicy(), repository, grants, control), true);
  const closed = { schema_version: 1, mode: "closed" };
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
      closed,
      grants
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

test("Beta preparation derives candidates from existing grants without enabling publication", () => {
  const prepare = { schema_version: 1, mode: "prepare" };
  const automatic = { schema_version: 1, mode: "automatic" };
  const closed = { schema_version: 1, mode: "closed" };
  assert.equal(betaReleaseCandidate(repository, grants, control), true);
  assert.equal(betaReleaseEnabled(prepare, repository, grants, control), false);
  assert.equal(betaReleaseEnabled(automatic, repository, grants, control), true);
  assert.equal(betaReleaseEnabled(closed, repository, grants, control), false);
  assert.equal(protectsFormalTags(formalTagProtection(prepare, repository, grants, control)), true);
  assert.equal(formalTagProtection(closed, repository, grants, control), undefined);
  const sourceOnly = { [repository]: ["pr", "release-source"] };
  assert.equal(betaReleaseEnabled(automatic, repository, sourceOnly, control), false);
  assert.equal(formalTagProtection(prepare, repository, sourceOnly, control), undefined);
  assert.equal(betaReleaseCandidate(control, { [control]: grants[repository] }, control), false);
  const next = "fongap-labs/new-repository";
  const expanded = { ...grants, [next]: grants[repository] };
  assert.equal(betaReleaseEnabled(automatic, next, expanded, control), true);
  assert.equal(protectsFormalTags(formalTagProtection(prepare, next, expanded, control)), true);
  assert.throws(() =>
    betaReleaseEnabled({ schema_version: 1, repositories: [] }, repository, grants, control)
  );
});
