import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNativeCiPilot } from "../scripts/native-ci-enrollment.ts";

const policy = {
  schema_version: 1,
  repositories: ["fongap-labs/delta-legacy"],
};

test("native evidence pilot is explicitly enrolled for private PRs only", () => {
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/delta-legacy", "true", "run-central-ci", "491"),
    true
  );
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/delta-legacy", "false", "run-central-ci", "491"),
    false
  );
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/delta-legacy", "true", "run-central-ci-ref", "0"),
    false
  );
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/delta", "true", "run-central-ci", "491"),
    false
  );
});

test("native evidence pilot refuses malformed or duplicate enrollment policies", () => {
  for (const invalid of [
    { ...policy, schema_version: 2 },
    { ...policy, repositories: [] },
    { ...policy, repositories: ["fongap-labs/delta-legacy", "fongap-labs/delta-legacy"] },
    { ...policy, repositories: ["untrusted"] },
  ]) {
    assert.throws(() =>
      resolveNativeCiPilot(invalid, "fongap-labs/delta-legacy", "true", "run-central-ci", "491")
    );
  }
  assert.throws(() => resolveNativeCiPilot(policy, "invalid", "true", "run-central-ci", "491"));
  assert.throws(() =>
    resolveNativeCiPilot(policy, "fongap-labs/delta-legacy", "1", "run-central-ci", "491")
  );
});
