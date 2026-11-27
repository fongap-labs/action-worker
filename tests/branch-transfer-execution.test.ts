import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTransferCompare,
  assertTransferReady,
  requireEquivalentTransferSnapshot,
  requireExclusiveTransferHead,
  revokeTransferHeadGate,
} from "../scripts/branch-transfer-execution.ts";
import { verifyTransferCommit } from "../scripts/branch-transfer-write.ts";
import { type PrCiScope, prCiScopeDescription } from "../scripts/ci-scope-receipt.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

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

test("regenerated synthetic merge SHA is accepted only for the exact ordered parents and tree", async () => {
  const refreshed = { ...scope, mergeSha: "d".repeat(40) };
  const original = {
    sha: scope.mergeSha,
    parents: [{ sha: scope.baseSha }, { sha: scope.headSha }],
    tree: { sha: "e".repeat(40) },
  };
  let replacement = { ...original, sha: refreshed.mergeSha };
  const reader = {
    async get(path: string) {
      if (path.endsWith(scope.mergeSha)) return original;
      if (path.endsWith(refreshed.mergeSha)) return replacement;
      throw new Error(path);
    },
  };
  await requireEquivalentTransferSnapshot(reader, scope, refreshed);
  await assert.rejects(
    requireEquivalentTransferSnapshot(reader, scope, { ...refreshed, prNumber: 104 })
  );
  await assert.rejects(
    requireEquivalentTransferSnapshot(reader, scope, { ...refreshed, baseSha: "f".repeat(40) })
  );
  replacement = { ...replacement, tree: { sha: "f".repeat(40) } };
  await assert.rejects(requireEquivalentTransferSnapshot(reader, scope, refreshed), /tree changed/);
  replacement = { ...original, sha: refreshed.mergeSha, parents: [...original.parents].reverse() };
  await assert.rejects(
    requireEquivalentTransferSnapshot(reader, scope, refreshed),
    /invalid parents/
  );
});

test("temporary target gate refuses a competing PR sharing the protected source SHA", async () => {
  let pulls = [pull];
  const reader = { get: async () => pulls };
  await requireExclusiveTransferHead(reader, scope);
  pulls = [pull, { ...pull, number: 104, head: { ...pull.head, ref: "fix/other" } }];
  await assert.rejects(requireExclusiveTransferHead(reader, scope), /Another target PR/);
  pulls = [];
  await assert.rejects(requireExclusiveTransferHead(reader, scope), /no longer open/);
});

test("temporary gate cleanup revokes only the current run's signed target status", async () => {
  const previousKeyring = process.env.AW_STATUS_KEYRING;
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.AW_STATUS_KEYRING = JSON.stringify({
    schema_version: 1,
    active: "k1",
    keys: { k1: "A".repeat(43) },
    legacy_tokens: [],
  });
  process.env.GITHUB_RUN_ATTEMPT = "1";
  try {
    const snapshot = prCiScopeDescription(scope);
    const targetUrl = "https://github.com/fongap-labs/action-worker/actions/runs/123";
    const native = {
      repository,
      sha: scope.headSha,
      state: "success" as const,
      context: "validate-merge",
      description: snapshot,
      targetUrl,
    };
    const status = {
      state: "success",
      context: native.context,
      description: signedStatusDescription(native),
      target_url: targetUrl,
      created_at: "2026-11-27T00:00:00Z",
    };
    let statuses = [status];
    const reader = { get: async () => ({ statuses }) };
    const calls: unknown[][] = [];
    const publish = async (...args: unknown[]) => {
      calls.push(args);
      statuses = [
        {
          ...status,
          state: "failure",
          description: signedStatusDescription({ ...native, state: "failure" }),
        },
      ];
    };
    const cleanup = (required = false) =>
      revokeTransferHeadGate(
        reader,
        repository,
        scope.headSha,
        "main",
        snapshot,
        targetUrl,
        publish,
        required,
        async () => undefined
      );
    await cleanup(true);
    assert.deepEqual(calls, [[scope.headSha, "validate-merge", "failure", snapshot]]);
    await cleanup(true);
    assert.equal(calls.length, 1);
    statuses = [{ ...status, target_url: targetUrl.replace("123", "456") }];
    await cleanup();
    assert.equal(calls.length, 1);
    await assert.rejects(cleanup(true), /different publisher/);
    statuses = [];
    await assert.rejects(cleanup(true), /Could not confirm/);
    statuses = [{ ...status, description: "unsigned" }];
    await assert.rejects(cleanup(), /mismatched/);
  } finally {
    if (previousKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
    else process.env.AW_STATUS_KEYRING = previousKeyring;
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
  }
});
