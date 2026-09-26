import assert from "node:assert/strict";
import test from "node:test";
import { isProtectedBranch, parseBranchPruneManifest } from "../scripts/prune-stale-branches.ts";

test("branch pruner always preserves default and legacy branches", () => {
  assert.equal(isProtectedBranch("main", "main"), true);
  assert.equal(isProtectedBranch("legacy/v1.0.0", "main"), true);
  assert.equal(isProtectedBranch("legacy/v0.2.x", "main"), true);
  assert.equal(isProtectedBranch("fix/example", "main"), false);
});

test("branch prune manifest is exact and cannot target protected branches", () => {
  assert.deepEqual(
    parseBranchPruneManifest(
      JSON.stringify({
        schema_version: "1",
        superseded_branches: ["refactor/old-path"],
      }),
      "main",
    ),
    {
      schema_version: "1",
      superseded_branches: ["refactor/old-path"],
    },
  );
  assert.throws(() => parseBranchPruneManifest(
    JSON.stringify({
      schema_version: "1",
      superseded_branches: ["main"],
    }),
    "main",
  ));
  assert.throws(() => parseBranchPruneManifest(
    JSON.stringify({
      schema_version: "1",
      superseded_branches: ["legacy/v1.0.0"],
    }),
    "main",
  ));
});
