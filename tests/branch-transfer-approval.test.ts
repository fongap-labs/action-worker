import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBranchTransferApproval,
  transferApprovalComment,
} from "../scripts/branch-transfer-approval.ts";
import { readCurrentPrCiScope, readCurrentTransferScope } from "../scripts/ci-scope-receipt.ts";

const control = "org/control";
const repository = "org/product";
const runId = 42;
const attempt = 1;
const scope = {
  repository,
  prNumber: 7,
  targetBranch: "main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  mergeSha: "c".repeat(40),
};

function fixture(targetBranch = "main") {
  const current = { ...scope, targetBranch };
  const source = targetBranch === "main" ? "dev" : "main";
  const prefix = `repos/${repository}`;
  const controlPrefix = `repos/${control}`;
  const runPath = `${controlPrefix}/actions/runs/${runId}`;
  const environmentPath = `${controlPrefix}/environments/branch-transfer`;
  const approvalsPath = `${runPath}/approvals`;
  const pullPath = `${prefix}/pulls/7`;
  const sourcePath = `${prefix}/branches/${source}`;
  const targetPath = `${prefix}/branches/${targetBranch}`;
  const mergePath = `${prefix}/git/commits/${scope.mergeSha}`;
  const run = {
    id: runId,
    run_attempt: attempt,
    repository: { full_name: control },
    head_branch: "main",
    path: ".github/workflows/handle-pr-dispatch.yml",
    status: "in_progress",
  };
  const environment = {
    id: 8,
    name: "branch-transfer",
    protection_rules: [
      { type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 9 } }] },
    ],
  };
  const approval = {
    state: "approved",
    user: { type: "User", id: 9 },
    environments: [{ id: 8, name: "branch-transfer" }],
    comment: transferApprovalComment(current, runId, attempt),
  };
  const pull = {
    state: "open",
    head: { ref: source, sha: current.headSha, repo: { full_name: repository } },
    base: { ref: targetBranch, repo: { full_name: repository } },
  };
  const entries = new Map<string, unknown>([
    [runPath, run],
    [environmentPath, environment],
    [approvalsPath, [approval]],
    [pullPath, pull],
    [sourcePath, { commit: { sha: current.headSha } }],
    [targetPath, { commit: { sha: current.baseSha } }],
    [`${prefix}/git/ref/pull/7/merge`, { object: { sha: current.mergeSha } }],
    [
      mergePath,
      { sha: current.mergeSha, parents: [{ sha: current.baseSha }, { sha: current.headSha }] },
    ],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(entries.has(path), path);
      return entries.get(path);
    },
  };
  const verify = () => assertBranchTransferApproval(reader, control, current, runId, attempt);
  return {
    reader,
    entries,
    verify,
    current,
    run,
    runPath,
    environmentPath,
    approvalsPath,
    approval,
    pull,
    pullPath,
    sourcePath,
    targetPath,
    mergePath,
  };
}

test("native environment authorization is bound to both transfer directions", async () => {
  for (const branch of ["main", "dev"]) {
    const { reader, verify, current } = fixture(branch);
    await assert.doesNotReject(verify());
    assert.deepEqual(await readCurrentTransferScope(reader, repository, 7, scope.headSha), current);
    await assert.rejects(
      readCurrentPrCiScope(reader, repository, 7, scope.headSha),
      /no longer matches/
    );
  }
});

test("missing, bot, unrelated and stale approvals cannot authorize a transfer", async () => {
  const { entries, verify, approval, approvalsPath } = fixture();
  for (const approvals of [
    [],
    [{ ...approval, user: { type: "Bot", id: 9 } }],
    [{ ...approval, user: { type: "User", id: 10 } }],
    [{ ...approval, environments: [{ id: 10, name: "branch-transfer" }] }],
    [{ ...approval, comment: "approved" }],
    [{ ...approval, comment: transferApprovalComment(scope, runId, 2) }],
    [
      {
        ...approval,
        comment: transferApprovalComment({ ...scope, targetBranch: "dev" }, runId, 1),
      },
    ],
  ]) {
    entries.set(approvalsPath, approvals);
    await assert.rejects(verify(), /approval is missing/);
  }
  entries.set(approvalsPath, [approval, { ...approval, state: "rejected" }]);
  await assert.rejects(verify(), /review was rejected/);
});

test("changed branch tips or merge parents invalidate the approved snapshot", async () => {
  for (const field of ["sourcePath", "targetPath", "mergePath"] as const) {
    const world = fixture();
    world.entries.set(world[field], { commit: { sha: "d".repeat(40) } });
    await assert.rejects(world.verify(), /scope changed/);
  }
  const world = fixture();
  world.entries.set(world.pullPath, {
    ...world.pull,
    head: { ...world.pull.head, repo: { full_name: "other/product" } },
  });
  await assert.rejects(world.verify(), /no longer matches/);
});

test("approval requires the current trusted run and configured user reviewers", async () => {
  const world = fixture();
  world.entries.set(world.runPath, { ...world.run, run_attempt: 2 });
  await assert.rejects(world.verify(), /current trusted governance run/);
  world.entries.set(world.runPath, { ...world.run, head_branch: "dev" });
  await assert.rejects(world.verify(), /current trusted governance run/);
  world.entries.set(world.runPath, world.run);
  world.entries.set(world.environmentPath, {
    id: 8,
    name: "branch-transfer",
    protection_rules: [],
  });
  await assert.rejects(world.verify(), /no explicit user reviewers/);
});
