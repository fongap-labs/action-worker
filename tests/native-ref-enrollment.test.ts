import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNativePrivateRef } from "../scripts/native-ref-enrollment.ts";

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

test("only explicitly enrolled private main/ref events use source-owned evidence", () => {
  assert.equal(
    resolveNativePrivateRef(policy, "fongap-labs/delta-legacy", "true", "run-central-ci-ref", "0"),
    true
  );
  for (const [repo, privateFlag, event, pr] of [
    ["fongap-labs/delta-legacy", "false", "run-central-ci-ref", "0"],
    ["fongap-labs/delta-legacy", "true", "run-central-ci", "491"],
    ["fongap-labs/delta-legacy", "true", "run-central-ci-ref", "491"],
    ["fongap-labs/delta", "true", "run-central-ci-ref", "0"],
  ] as const) {
    assert.equal(resolveNativePrivateRef(policy, repo, privateFlag, event, pr), false);
  }
});

test("invalid, duplicate or untrusted private main enrollment fails closed", () => {
  for (const malformed of [
    { ...policy, schema_version: 2 },
    { ...policy, callers: [] },
    { ...policy, callers: [...policy.callers, ...policy.callers] },
    { ...policy, callers: [{ ...policy.callers[0], path: "wrong.yml" }] },
    { ...policy, callers: [{ ...policy.callers[0], sha256: "abc" }] },
  ]) {
    assert.throws(() =>
      resolveNativePrivateRef(
        malformed,
        "fongap-labs/delta-legacy",
        "true",
        "run-central-ci-ref",
        "0"
      )
    );
  }
  assert.throws(() => resolveNativePrivateRef(policy, "../bad", "true", "run-central-ci-ref", "0"));
  assert.throws(() =>
    resolveNativePrivateRef(
      policy,
      "fongap-labs/delta-legacy",
      "notbool",
      "run-central-ci-ref",
      "0"
    )
  );
  assert.throws(() =>
    resolveNativePrivateRef(policy, "fongap-labs/delta-legacy", "true", "run-central-ci-ref", "-1")
  );
});
