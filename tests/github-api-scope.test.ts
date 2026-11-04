import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGithubApiScope } from "../scripts/resolve-github-api-scope.ts";

const policy = {
  "fongap-labs/action-worker": ["pr", "deploy"],
  "fongap-labs/mcp-hub": ["pr", "deploy"],
  "fongap-labs/delta": ["pr"],
  "another-org/example": ["pr"],
};

test("control repository is authorized for GITHUB_TOKEN", () => {
  assert.deepEqual(
    resolveGithubApiScope("fongap-labs/action-worker", "fongap-labs/action-worker", policy, "pr"),
    { owner: "fongap-labs", repository_name: "action-worker", is_control_repository: true }
  );
});

test("each managed repository has its own App installation scope", () => {
  for (const repository_name of ["mcp-hub", "delta"]) {
    assert.deepEqual(
      resolveGithubApiScope(
        `fongap-labs/${repository_name}`,
        "fongap-labs/action-worker",
        policy,
        "pr"
      ),
      { owner: "fongap-labs", repository_name, is_control_repository: false }
    );
  }
});

test("App token scope cannot bypass repository capability grants or owner boundary", () => {
  assert.throws(() =>
    resolveGithubApiScope("fongap-labs/delta", "fongap-labs/action-worker", policy, "deploy")
  );
  assert.throws(() =>
    resolveGithubApiScope("fongap-labs/unmanaged", "fongap-labs/action-worker", policy, "pr")
  );
  assert.throws(
    () => resolveGithubApiScope("another-org/example", "fongap-labs/action-worker", policy, "pr"),
    /Cross-owner access requires/
  );
  assert.throws(() =>
    resolveGithubApiScope("not-a-repository", "fongap-labs/action-worker", policy, "pr")
  );
});
