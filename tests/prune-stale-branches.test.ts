import assert from "node:assert/strict";
import test from "node:test";
import { isProtectedBranch } from "../scripts/prune-stale-branches.ts";

test("branch pruner always preserves default and legacy branches", () => {
  assert.equal(isProtectedBranch("main", "main"), true);
  assert.equal(isProtectedBranch("legacy/v1.0.0", "main"), true);
  assert.equal(isProtectedBranch("legacy/v0.2.x", "main"), true);
  assert.equal(isProtectedBranch("fix/example", "main"), false);
});
