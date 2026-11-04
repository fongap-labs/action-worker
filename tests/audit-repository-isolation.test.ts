import assert from "node:assert/strict";
import { test } from "node:test";
import { type AuditResult, countAuditResults } from "../scripts/audit-main-writes.ts";

const sha = "a".repeat(40);

test("one rejected repository does not change the verdict of another", () => {
  const results: AuditResult[] = [
    { repository: "org/healthy", main_sha: sha, state: "success", detail: "PR #1" },
    { repository: "org/violating", main_sha: sha, state: "failure", detail: "status-missing" },
    { repository: "org/waiting", main_sha: sha, state: "pending", detail: "run-still-running" },
  ];
  assert.deepEqual(countAuditResults(results), { verified: 1, rejected: 1, pending: 1 });
  assert.equal(results[0]?.state, "success");
  assert.equal(results[1]?.state, "failure");
});

test("all trusted repositories are counted independently", () => {
  const results: AuditResult[] = [
    { repository: "org/one", main_sha: sha, state: "success", detail: "PR #2" },
    { repository: "org/two", main_sha: sha, state: "success", detail: "PR #3" },
  ];
  assert.deepEqual(countAuditResults(results), { verified: 2, rejected: 0, pending: 0 });
});
