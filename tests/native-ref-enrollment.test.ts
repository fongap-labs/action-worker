import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNativeRefEnrollment } from "../scripts/native-ref-enrollment.ts";

const policy = {
  schema_version: 1,
  callers: [
    {
      repository: "fongap-labs/delta-legacy",
      path: ".github/workflows/private-ref-ci.yml",
      sha256: "a".repeat(64),
    },
  ],
};

test("protected private main enrollment is opt-in and never PR, public or manual", () => {
  assert.equal(
    resolveNativeRefEnrollment(
      policy,
      "fongap-labs/delta-legacy",
      "true",
      "run-central-ci-ref",
      "0"
    ),
    true
  );
  for (const [repo, visibility, action, number] of [
    ["fongap-labs/delta-legacy", "false", "run-central-ci-ref", "0"],
    ["fongap-labs/delta-legacy", "true", "run-central-ci", "495"],
    ["fongap-labs/delta", "true", "run-central-ci-ref", "0"],
    ["fongap-labs/delta-legacy", "true", "run-central-ci-ref", "495"],
    ["fongap-labs/delta-legacy", "true", "workflow_dispatch", "0"],
  ]) {
    assert.equal(resolveNativeRefEnrollment(policy, repo!, visibility!, action!, number!), false);
  }
});

test("private ref enrollment refuses malformed or duplicate policy", () => {
  const invalid: unknown[] = [
    null,
    { ...policy, schema_version: 2 },
    { ...policy, callers: [] },
    { ...policy, callers: [policy.callers[0], policy.callers[0]] },
    { ...policy, callers: [{ ...policy.callers[0], sha256: "main" }] },
    { ...policy, callers: [{ ...policy.callers[0], path: ".github/workflows/other.yml" }] },
  ];
  for (const input of invalid) {
    assert.throws(() =>
      resolveNativeRefEnrollment(
        input,
        "fongap-labs/delta-legacy",
        "true",
        "run-central-ci-ref",
        "0"
      )
    );
  }
  assert.throws(() =>
    resolveNativeRefEnrollment(policy, "invalid/repo/path", "true", "run-central-ci-ref", "0")
  );
  for (const malformed of ["../bad", "owner/..", "./bad", "owner/."]) {
    assert.throws(() =>
      resolveNativeRefEnrollment(policy, malformed, "true", "run-central-ci-ref", "0")
    );
  }
  assert.throws(() =>
    resolveNativeRefEnrollment(
      { ...policy, callers: [{ ...policy.callers[0], repository: "owner/.." }] },
      "fongap-labs/delta-legacy",
      "true",
      "run-central-ci-ref",
      "0"
    )
  );
});
