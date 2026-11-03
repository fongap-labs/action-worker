import assert from "node:assert/strict";
import { test } from "node:test";
import { requireAuditCredential } from "../scripts/audit-main-writes.ts";

test("Main Write Audit requires scoped tokens without control-token fallback", () => {
  const withControlOnly = { AW_CONTROL_TOKEN: "control" };
  for (const [name, permission] of [
    ["AW_STATUS_TOKEN", "Commit statuses: Read and write"],
    ["AW_ISSUE_TOKEN", "Issues: Read and write"],
  ] as const) {
    assert.throws(
      () => requireAuditCredential(name, permission, withControlOnly),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(name) &&
        error.message.includes(permission) &&
        error.message.includes("No token fallback")
    );
  }
});

test("Main Write Audit reads each dedicated credential independently", () => {
  const env = {
    AW_CONTROL_TOKEN: "control",
    AW_STATUS_TOKEN: "status",
    AW_ISSUE_TOKEN: "issue",
  };
  assert.equal(
    requireAuditCredential("AW_STATUS_TOKEN", "Commit statuses: Read and write", env),
    "status"
  );
  assert.equal(requireAuditCredential("AW_ISSUE_TOKEN", "Issues: Read and write", env), "issue");
  assert.equal(requireAuditCredential("AW_CONTROL_TOKEN", "managed repository reads", env), "control");
});
