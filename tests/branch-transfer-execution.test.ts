import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTransferCompare,
  assertTransferReady,
} from "../scripts/branch-transfer-execution.ts";
import { verifyTransferCommit } from "../scripts/branch-transfer-write.ts";
import { type PrCiScope, prCiScopeDescription } from "../scripts/ci-scope-receipt.ts";

const repository = "fongap-labs/product";
const scope: PrCiScope = {
  repository,
  prNumber: 103,
  targetBranch: "main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  mergeSha: "c".repeat(40),
};
const repo = { full_name: repository };
const pull = {
  number: scope.prNumber,
  state: "open",
  draft: false,
  mergeable: true,
  mergeable_state: "blocked",
  title: "feat: promote development",
  author_association: "OWNER",
  head: { ref: "dev", sha: scope.headSha, repo },
  base: { ref: "main", sha: scope.baseSha, repo },
};

test("transfer admission binds exact PR, branches and reviewed snapshot", () => {
  const digest = prCiScopeDescription(scope);
  assert.equal(assertTransferReady(scope, digest, pull), pull.title);
  for (const changed of [
    { ...pull, number: 104 },
    { ...pull, draft: true },
    { ...pull, state: "closed" },
    { ...pull, mergeable_state: "behind" },
    { ...pull, head: { ...pull.head, sha: "d".repeat(40) } },
    { ...pull, head: { ...pull.head, ref: "fix/example" } },
    { ...pull, head: { ...pull.head, repo: { full_name: "other/fork" } } },
    { ...pull, base: { ...pull.base, ref: "dev" } },
  ]) {
    assert.throws(() => assertTransferReady(scope, digest, changed));
  }
  assert.throws(() => assertTransferReady(scope, "wrong", pull));
  assert.throws(() => assertTransferReady(scope, digest, pull, "wrong"));
});

test("transfer rejects divergence and missing comparison evidence", () => {
  const compare = {
    status: "ahead",
    ahead_by: 2,
    behind_by: 0,
    merge_base_commit: { sha: scope.baseSha },
  };
  assert.doesNotThrow(() => assertTransferCompare(scope, compare));
  for (const changed of [
    { ...compare, status: "diverged" },
    { ...compare, behind_by: 1 },
    { ...compare, behind_by: undefined },
    { ...compare, merge_base_commit: { sha: scope.headSha } },
  ]) {
    assert.throws(() => assertTransferCompare(scope, changed));
  }
});

test("transfer receipt binds actual squash tree and both synthetic parents", () => {
  const writeSha = "d".repeat(40);
  const tree = { sha: "e".repeat(40) };
  const merged = {
    ...pull,
    state: "closed",
    merged: true,
    merged_at: "2026-11-27T00:00:00Z",
    merge_commit_sha: writeSha,
  };
  const commit = { sha: writeSha, tree, parents: [{ sha: scope.baseSha }] };
  const snapshot = {
    sha: scope.mergeSha,
    tree,
    parents: [{ sha: scope.baseSha }, { sha: scope.headSha }],
  };
  assert.doesNotThrow(() => verifyTransferCommit(scope, writeSha, merged, commit, snapshot));
  assert.throws(() =>
    verifyTransferCommit(scope, writeSha, { ...merged, number: 104 }, commit, snapshot)
  );
  assert.throws(() =>
    verifyTransferCommit(
      scope,
      writeSha,
      merged,
      { ...commit, parents: [{ sha: scope.headSha }] },
      snapshot
    )
  );
  assert.throws(() =>
    verifyTransferCommit(scope, writeSha, merged, commit, {
      ...snapshot,
      tree: { sha: scope.baseSha },
    })
  );
});
