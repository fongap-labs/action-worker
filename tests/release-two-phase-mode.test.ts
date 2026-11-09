import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseTwoPhaseReleasePolicy,
  selectReleasePhase,
  stagingReleaseTimeoutMinutes,
} from "../scripts/release-two-phase-mode.ts";

const target = "fongap-labs/release-staging-fixture";

test("source-controlled two-phase staging policy begins with zero approved targets", () => {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../policies/release-two-phase-staging.json", import.meta.url), "utf8")
  );
  assert.deepEqual(parseTwoPhaseReleasePolicy(value), {
    schema_version: 1,
    approved_staging_repositories: [],
  });
});

test("the live release workflow has no two-phase opt-in or PR write scope", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/handle-release-dispatch.yml", import.meta.url),
    "utf8"
  );
  assert.equal(workflow.includes("AW_RELEASE_TWO_PHASE_MODE"), false);
  assert.equal(workflow.includes("AW_RELEASE_PR_WRITE_API_TOKEN"), false);
  assert.equal(workflow.includes("AW_RELEASE_PR_STATUS_API_TOKEN"), false);
  assert.equal(workflow.includes("permission-pull-requests: write"), false);
});

test("release driver actually wires staging PR merge SHA into target_commitish", () => {
  const source = readFileSync(new URL("../scripts/publish-release.ts", import.meta.url), "utf8");
  assert.match(source, /selectReleasePhase\(/);
  assert.match(source, /phase\.kind === "staging"/);
  assert.match(source, /await publishChangelogRelease\(/);
  assert.match(source, /releaseSha = staged\.mergeSha/);
  assert.match(source, /target_commitish=\$\{releaseSha\}/);
});

test("default release path remains read-only even with a staging policy", () => {
  const policy = parseTwoPhaseReleasePolicy({
    schema_version: 1,
    approved_staging_repositories: [],
  });
  assert.deepEqual(
    selectReleasePhase(
      { mode: undefined, targetRepository: target, prToken: undefined, statusToken: undefined },
      policy
    ),
    { kind: "read-only" }
  );
  assert.deepEqual(
    selectReleasePhase(
      { mode: "read-only", targetRepository: target, prToken: undefined, statusToken: undefined },
      policy
    ),
    { kind: "read-only" }
  );
});

test("staging two-phase mode fails closed until policy and PR scope are both approved", () => {
  const emptyPolicy = parseTwoPhaseReleasePolicy({
    schema_version: 1,
    approved_staging_repositories: [],
  });
  const input = {
    mode: "staging",
    targetRepository: target,
    prToken: "fake-scoped-token",
    statusToken: "fake-read-token",
  };
  assert.throws(() => selectReleasePhase(input, emptyPolicy), /reviewed staging allowlist/);
  const policy = parseTwoPhaseReleasePolicy({
    schema_version: 1,
    approved_staging_repositories: [target],
  });
  assert.throws(
    () => selectReleasePhase({ ...input, prToken: undefined }, policy),
    /Dedicated target-scoped PR write and status read tokens/
  );
  assert.throws(
    () => selectReleasePhase({ ...input, statusToken: undefined }, policy),
    /Dedicated target-scoped PR write and status read tokens/
  );
  assert.deepEqual(selectReleasePhase(input, policy), {
    kind: "staging",
    prToken: "fake-scoped-token",
    statusToken: "fake-read-token",
    timeoutMinutes: stagingReleaseTimeoutMinutes,
  });
  assert.ok(stagingReleaseTimeoutMinutes < 20);
});

test("unrecognized modes and malformed policy entries never enable writes", () => {
  const policy = parseTwoPhaseReleasePolicy({
    schema_version: 1,
    approved_staging_repositories: [target],
  });
  assert.throws(
    () =>
      selectReleasePhase(
        {
          mode: "production",
          targetRepository: target,
          prToken: "fake-scoped-token",
          statusToken: "fake-read-token",
        },
        policy
      ),
    /Unknown two-phase Release mode/
  );
  for (const value of [
    null,
    {},
    { schema_version: 2, approved_staging_repositories: [target] },
    { schema_version: 1, approved_staging_repositories: ["not a repository"] },
    { schema_version: 1, approved_staging_repositories: [target, target] },
    { schema_version: 1, approved_staging_repositories: "any" },
  ]) {
    assert.throws(() => parseTwoPhaseReleasePolicy(value), /staging policy is invalid/);
  }
});
