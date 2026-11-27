import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readTransferPlan,
  transferIntentDescription,
  transferPlanDescription,
  transferStageMessage,
  transferStageRef,
  verifyIntentObjects,
} from "../scripts/branch-transfer-intent.ts";
import {
  createStagedTransfer,
  verifyStagedTransferProof,
} from "../scripts/branch-transfer-staging.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const repository = "fongap-labs/product";
const prefix = `repos/${repository}`;
const baseSha = "a".repeat(40);
const sourceSha = "b".repeat(40);
const anchorSha = "c".repeat(40);
const mergeSha = "d".repeat(40);
const baseTree = "e".repeat(40);
const sourceTree = "f".repeat(40);
const mergedTree = "1".repeat(40);
const stageHead = "2".repeat(40);
const stageMerge = "3".repeat(40);
const runId = 42;
const runUrl = "https://github.com/fongap-labs/action-worker/actions/runs/42";

function world(target: "main" | "dev" = "main") {
  const source = target === "main" ? "dev" : "main";
  const repo = { full_name: repository, private: false, default_branch: "main" };
  const pull = {
    number: 103,
    state: "open",
    draft: false,
    mergeable: false,
    mergeable_state: "dirty",
    title: "fix: promote verified changes",
    author_association: "OWNER",
    head: { ref: source, sha: sourceSha, repo },
    base: { ref: target, sha: baseSha, repo },
  };
  const entries = new Map<string, unknown>([
    [prefix, repo],
    [`${prefix}/pulls/103`, pull],
    [`${prefix}/branches/${source}`, { commit: { sha: sourceSha } }],
    [`${prefix}/branches/${target}`, { commit: { sha: baseSha } }],
    [`${prefix}/git/commits/${baseSha}`, { sha: baseSha, tree: { sha: baseTree } }],
    [`${prefix}/git/commits/${sourceSha}`, { sha: sourceSha, tree: { sha: sourceTree } }],
    [`${prefix}/git/commits/${anchorSha}`, { sha: anchorSha, tree: { sha: baseTree } }],
    [
      `${prefix}/compare/${baseSha}...${sourceSha}`,
      {
        status: "diverged",
        ahead_by: 3,
        behind_by: 1,
        merge_base_commit: { sha: mergeSha },
      },
    ],
    [
      `${prefix}/compare/${anchorSha}...${sourceSha}`,
      {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        merge_base_commit: { sha: anchorSha },
      },
    ],
    [
      `${prefix}/commits?sha=${sourceSha}&per_page=100&page=1`,
      [
        { sha: sourceSha, commit: { tree: { sha: sourceTree } } },
        { sha: anchorSha, commit: { tree: { sha: baseTree } } },
      ],
    ],
    [`${prefix}/git/ref/pull/103/merge`, { object: { sha: mergeSha } }],
    [
      `${prefix}/git/commits/${mergeSha}`,
      {
        sha: mergeSha,
        parents: [{ sha: baseSha }, { sha: sourceSha }],
        tree: { sha: mergedTree },
      },
    ],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      if (!entries.has(path)) throw new Error(`Unexpected path: ${path}`);
      return entries.get(path);
    },
  };
  const plan = () => readTransferPlan(reader, repository, 103, sourceSha);
  return { entries, reader, plan, pull, target, source, repo };
}

test("squash divergence can repeat in either direction using an ancestral equal tree", async () => {
  for (const target of ["main", "dev"] as const) {
    const w = world(target);
    const p = await w.plan();
    assert.equal(p.kind, "staged");
    if (p.kind !== "staged") assert.fail();
    assert.equal(p.intent.mode, "source-tree");
    assert.equal(p.intent.basisSha, anchorSha);
    assert.equal(p.intent.treeSha, sourceTree);
    assert.equal(transferStageRef(p.intent, runId), `aw-transfer/${w.source}/103/42`);
    await verifyIntentObjects(w.reader, p.intent);
    w.entries.set(`${prefix}/git/commits/${sourceSha}`, {
      sha: sourceSha,
      tree: { sha: baseTree },
    });
    assert.equal((await w.plan()).kind, "noop");
  }
});

test("independent target content needs an exact clean integrated tree; conflicts fail closed", async () => {
  const w = world();
  w.entries.set(`${prefix}/commits?sha=${sourceSha}&per_page=100&page=1`, []);
  await assert.rejects(w.plan(), /no verified common-content anchor/);
  w.entries.set(`${prefix}/pulls/103`, { ...w.pull, mergeable: true, mergeable_state: "behind" });
  const p = await w.plan();
  assert.equal(p.kind, "staged");
  if (p.kind !== "staged") assert.fail();
  assert.equal(p.intent.mode, "merge-tree");
  assert.equal(p.intent.treeSha, mergedTree);
  await verifyIntentObjects(w.reader, p.intent);
  assert.equal(
    transferPlanDescription(p),
    transferIntentDescription({ ...p.intent, basisSha: stageMerge })
  );
  w.entries.set(`${prefix}/git/commits/${mergeSha}`, {
    sha: mergeSha,
    parents: [{ sha: sourceSha }, { sha: baseSha }],
    tree: { sha: mergedTree },
  });
  await assert.rejects(w.plan());
});

test("an unproved history anchor or changed protected source cannot authorize staging", async () => {
  const w = world();
  w.entries.set(`${prefix}/compare/${anchorSha}...${sourceSha}`, {
    status: "diverged",
    ahead_by: 1,
    behind_by: 1,
    merge_base_commit: { sha: mergeSha },
  });
  await assert.rejects(w.plan(), /not an ancestor/);
  w.entries.set(`${prefix}/branches/dev`, { commit: { sha: stageHead } });
  await assert.rejects(w.plan(), /refs changed/);
});

test("staging creates only a new ref and exact PR; signed proof binds original intent", async () => {
  const w = world();
  const p = await w.plan();
  if (p.kind !== "staged") assert.fail();
  const ref = transferStageRef(p.intent, runId);
  const commit = {
    sha: stageHead,
    tree: { sha: sourceTree },
    parents: [{ sha: baseSha }],
    message: transferStageMessage(p.intent),
  };
  const stagedPull = {
    ...w.pull,
    number: 104,
    head: { ref, sha: stageHead, repo: w.repo },
    mergeable: true,
    mergeable_state: "blocked",
  };
  const previous = process.env.AW_STATUS_KEYRING;
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.AW_STATUS_KEYRING = JSON.stringify({
    schema_version: 1,
    active: "k1",
    keys: { k1: "A".repeat(43) },
    legacy_tokens: [],
  });
  process.env.GITHUB_RUN_ATTEMPT = "1";
  const calls: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === `${prefix}/git/ref/heads/${ref}`) return undefined;
      return w.reader.get(path);
    },
  };
  try {
    const result = await createStagedTransfer(
      reader,
      async (method, path, body) => {
        calls.push(`${method} ${path}`);
        if (path.endsWith("/git/commits")) {
          assert.deepEqual(body, {
            message: transferStageMessage(p.intent),
            tree: sourceTree,
            parents: [baseSha],
          });
          w.entries.set(`${prefix}/git/commits/${stageHead}`, commit);
          return commit;
        }
        if (path.endsWith("/git/refs")) {
          assert.deepEqual(body, { ref: `refs/heads/${ref}`, sha: stageHead });
          w.entries.set(`${prefix}/branches/${encodeURIComponent(ref)}`, {
            commit: { sha: stageHead },
          });
          return {};
        }
        if (path.endsWith("/pulls")) {
          w.entries.set(`${prefix}/pulls/104`, stagedPull);
          w.entries.set(`${prefix}/git/ref/pull/104/merge`, { object: { sha: stageMerge } });
          w.entries.set(`${prefix}/git/commits/${stageMerge}`, {
            sha: stageMerge,
            tree: { sha: sourceTree },
            parents: [{ sha: baseSha }, { sha: stageHead }],
          });
          return stagedPull;
        }
        assert.fail(path);
      },
      async (sha, context, state, description) => {
        w.entries.set(`${prefix}/commits/${sha}/status`, {
          statuses: [
            {
              context,
              state,
              target_url: runUrl,
              created_at: "2026-11-27T00:00:00Z",
              description: signedStatusDescription({
                repository,
                sha,
                context,
                state,
                description,
                targetUrl: runUrl,
              }),
            },
          ],
        });
      },
      p.intent,
      p.title,
      runId,
      async () => undefined,
      async () => undefined
    );
    assert.deepEqual(calls, [
      `POST ${prefix}/git/commits`,
      `POST ${prefix}/git/refs`,
      `POST ${prefix}/pulls`,
    ]);
    assert.equal(result.scope.prNumber, 104);
    const proof = await verifyStagedTransferProof(reader, result.scope, ref, runId, runUrl);
    assert.deepEqual(proof.intent, p.intent);
    await assert.rejects(verifyStagedTransferProof(reader, result.scope, ref, 43, runUrl));
    w.entries.set(`${prefix}/commits/${stageHead}/status`, { statuses: [] });
    await assert.rejects(
      verifyStagedTransferProof(reader, result.scope, ref, runId, runUrl),
      /Missing signed/
    );
  } finally {
    if (previous === undefined) delete process.env.AW_STATUS_KEYRING;
    else process.env.AW_STATUS_KEYRING = previous;
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
  }
});
