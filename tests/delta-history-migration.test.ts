import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDeltaHistoryMigrationTarget,
  readDeltaHistoryPolicy,
  verifyDeltaHistoryMigration,
} from "../scripts/delta-history-migration.ts";
import type { GithubReader } from "../scripts/github-api.ts";

const manifest = readDeltaHistoryPolicy();
const repo = manifest.repository;

function fixture(
  stage: "preflight" | "cutover" = "preflight",
  changes: Record<string, unknown> = {}
): { reader: GithubReader; reads: string[] } {
  const responses = new Map<string, unknown>();
  const prefix = `repos/${repo}`;
  const refs: Array<[string, string]> = [
    ["main", stage === "preflight" ? manifest.source_sha : manifest.target_sha],
    [manifest.source_backup_ref, manifest.source_sha],
    [manifest.target_ref, manifest.target_sha],
    [manifest.baseline_ref, manifest.baseline_sha],
    [manifest.upstream_ref, manifest.baseline_sha],
  ];
  for (const [ref, sha] of refs) {
    responses.set(`${prefix}/git/ref/heads/${ref}`, { object: { sha } });
  }
  let previousSource = "";
  let previousTarget = manifest.baseline_sha;
  for (const [i, snapshot] of manifest.snapshots.entries()) {
    responses.set(`${prefix}/git/commits/${snapshot.source_sha}`, {
      sha: snapshot.source_sha,
      tree: { sha: snapshot.tree_sha },
      parents: i === 0 ? [] : [{ sha: previousSource }],
    });
    responses.set(`${prefix}/git/commits/${snapshot.target_sha}`, {
      sha: snapshot.target_sha,
      tree: { sha: snapshot.tree_sha },
      parents: [{ sha: previousTarget }],
    });
    previousSource = snapshot.source_sha;
    previousTarget = snapshot.target_sha;
  }
  responses.set(`${prefix}/compare/${manifest.baseline_sha}...${manifest.target_sha}`, {
    status: "ahead",
    ahead_by: 8,
    behind_by: 0,
    merge_base_commit: { sha: manifest.baseline_sha },
  });
  for (const [path, value] of Object.entries(changes)) responses.set(path, value);
  const reads: string[] = [];
  return {
    reads,
    reader: {
      async get(path: string): Promise<unknown> {
        reads.push(path);
        if (!responses.has(path)) throw new Error(`Unexpected API path: ${path}`);
        return responses.get(path);
      },
    } as GithubReader,
  };
}

test("one-time Delta target identity is fail-closed for all other repositories and SHAs", async () => {
  assert.equal(isDeltaHistoryMigrationTarget(repo, manifest.target_sha), true);
  assert.equal(isDeltaHistoryMigrationTarget(repo, manifest.source_sha), false);
  assert.equal(
    isDeltaHistoryMigrationTarget("fongap-labs/action-worker", manifest.target_sha),
    false
  );
  const { reader, reads } = fixture();
  assert.equal(await verifyDeltaHistoryMigration(reader, repo, manifest.source_sha), null);
  assert.equal(
    await verifyDeltaHistoryMigration(reader, "fongap-labs/dsh-plugin", manifest.target_sha),
    null
  );
  assert.deepEqual(reads, []);
});

test("preflight accepts exactly eight identical historical snapshots without changing main", async () => {
  const { reader } = fixture();
  assert.deepEqual(
    await verifyDeltaHistoryMigration(reader, repo, manifest.target_sha, "preflight"),
    manifest
  );
});

test("cutover accepts only the exact target SHA as main after historical switch", async () => {
  const { reader } = fixture("cutover");
  assert.deepEqual(await verifyDeltaHistoryMigration(reader, repo, manifest.target_sha), manifest);
});

test("migration rejects any main or legacy backup ref drift", async () => {
  const prefix = `repos/${repo}`;
  const bad = [
    `${prefix}/git/ref/heads/main`,
    `${prefix}/git/ref/heads/${manifest.source_backup_ref}`,
    `${prefix}/git/ref/heads/${manifest.target_ref}`,
    `${prefix}/git/ref/heads/${manifest.baseline_ref}`,
    `${prefix}/git/ref/heads/${manifest.upstream_ref}`,
  ];
  for (const path of bad) {
    const { reader } = fixture("preflight", { [path]: { object: { sha: "f".repeat(40) } } });
    await assert.rejects(
      verifyDeltaHistoryMigration(reader, repo, manifest.target_sha, "preflight"),
      /protected reference/
    );
  }
});

test("migration rejects modified source, candidate, and intermediate tree snapshots", async () => {
  const prefix = `repos/${repo}`;
  for (const snapshot of [manifest.snapshots[0]!, manifest.snapshots[3]!, manifest.snapshots[7]!]) {
    for (const sha of [snapshot.source_sha, snapshot.target_sha]) {
      const path = `${prefix}/git/commits/${sha}`;
      const { reader } = fixture("preflight", {
        [path]: { sha, tree: { sha: "f".repeat(40) }, parents: [{ sha: manifest.baseline_sha }] },
      });
      await assert.rejects(
        verifyDeltaHistoryMigration(reader, repo, manifest.target_sha, "preflight"),
        /snapshot/
      );
    }
  }
});

test("migration rejects a fake ancestor relation and hidden missing upstream commits", async () => {
  const key = `repos/${repo}/compare/${manifest.baseline_sha}...${manifest.target_sha}`;
  for (const change of [
    {
      status: "diverged",
      ahead_by: 8,
      behind_by: 1,
      merge_base_commit: { sha: manifest.baseline_sha },
    },
    {
      status: "ahead",
      ahead_by: 28264,
      behind_by: 0,
      merge_base_commit: { sha: manifest.baseline_sha },
    },
    { status: "ahead", ahead_by: 8, behind_by: 0, merge_base_commit: { sha: "f".repeat(40) } },
  ]) {
    const { reader } = fixture("preflight", { [key]: change });
    await assert.rejects(
      verifyDeltaHistoryMigration(reader, repo, manifest.target_sha, "preflight"),
      /does not descend linearly/
    );
  }
});
