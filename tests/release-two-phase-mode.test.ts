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

test("default release path remains read-only even with a staging policy", () => {
  const policy = parseTwoPhaseReleasePolicy({
    schema_version: 1,
    approved_staging_repositories: [],
  });
  assert.deepEqual(
    selectReleasePhase({ mode: undefined, targetRepository: target, prToken: undefined }, policy),
    { kind: "read-only" }
  );
  assert.deepEqual(
    selectReleasePhase({ mode: "read-only", targetRepository: target, prToken: undefined }, policy),
    { kind: "read-only" }
  );
});

test("staging two-phase mode fails closed until policy and PR scope are both approved", () => {
  const emptyPolicy = parseTwoPhaseReleasePolicy({
    schema_version: 1,
    approved_staging_repositories: [],
  });
  const input = { mode: "staging", targetRepository: target, prToken: "fake-scoped-token" };
  assert.throws(() => selectReleasePhase(input, emptyPolicy), /reviewed staging allowlist/);
  const policy = parseTwoPhaseReleasePolicy({
    schema_version: 1,
    approved_staging_repositories: [target],
  });
  assert.throws(
    () => selectReleasePhase({ ...input, prToken: undefined }, policy),
    /dedicated target-scoped PR write token/
  );
  assert.deepEqual(selectReleasePhase(input, policy), {
    kind: "staging",
    prToken: "fake-scoped-token",
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
        { mode: "production", targetRepository: target, prToken: "fake-scoped-token" },
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
