import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNativeCiPilot } from "../scripts/native-ci-enrollment.ts";

const policy = {
  schema_version: 1,
  repositories: ["fongap-labs/private-fixture"],
};

test("native evidence pilot is explicitly enrolled for private PRs only", () => {
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/private-fixture", "true", "run-central-ci", "491"),
    true
  );
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/private-fixture", "false", "run-central-ci", "491"),
    false
  );
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/private-fixture", "true", "run-central-ci-ref", "0"),
    false
  );
  assert.equal(
    resolveNativeCiPilot(policy, "fongap-labs/delta", "true", "run-central-ci", "491"),
    false
  );
});

test("empty private CI pilot policy leaves all targets on the standard CI path", () => {
  assert.equal(
    resolveNativeCiPilot(
      { schema_version: 1, repositories: [] },
      "fongap-labs/private-fixture",
      "true",
      "run-central-ci",
      "491"
    ),
    false
  );
});

test("native evidence pilot refuses malformed or duplicate enrollment policies", () => {
  for (const invalid of [
    { ...policy, schema_version: 2 },
    { ...policy, repositories: ["fongap-labs/private-fixture", "fongap-labs/private-fixture"] },
    { ...policy, repositories: ["untrusted"] },
  ]) {
    assert.throws(() =>
      resolveNativeCiPilot(invalid, "fongap-labs/private-fixture", "true", "run-central-ci", "491")
    );
  }
  assert.throws(() => resolveNativeCiPilot(policy, "invalid", "true", "run-central-ci", "491"));
  assert.throws(() =>
    resolveNativeCiPilot(policy, "fongap-labs/private-fixture", "1", "run-central-ci", "491")
  );
});

test("private dev always uses source-owned CI without a per-repository pilot list", () => {
  const empty = { schema_version: 1, repositories: [] };
  assert.equal(
    resolveNativeCiPilot(empty, "fongap-labs/private-fixture", "true", "run-central-ci", "7", "dev"),
    true
  );
  assert.equal(
    resolveNativeCiPilot(empty, "fongap-labs/private-fixture", "false", "run-central-ci", "7", "dev"),
    false
  );
});
