import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuditResult,
  countAuditResults,
  isTransientAuditReadFailure,
} from "../scripts/audit-main-writes.ts";
import { GithubHttpError } from "../scripts/github-api.ts";

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

test("transient GitHub API failures are pending rather than evidence of an untrusted write", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientAuditReadFailure(new GithubHttpError(status)), true);
  }
  for (const kind of ["primary-rate-limit", "secondary-rate-limit"] as const) {
    assert.equal(isTransientAuditReadFailure(new GithubHttpError(403, undefined, { kind })), true);
  }
  assert.equal(isTransientAuditReadFailure(new GithubHttpError(403)), false);
  assert.equal(isTransientAuditReadFailure(new GithubHttpError(404)), false);
  assert.equal(isTransientAuditReadFailure(new Error("Untrusted main write")), false);
});
