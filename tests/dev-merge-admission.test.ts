import assert from "node:assert/strict";
import { test } from "node:test";
import { devGovernanceReceipt, prCiScopeDescription } from "../scripts/ci-scope-receipt.ts";
import { verifyDevMergeAdmission, verifyDevSquashWrite } from "../scripts/dev-merge-admission.ts";
import { verifyRecordedDevWrite } from "../scripts/dev-write-guard.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/example";
const control = "fongap-labs/action-worker";
const scope = {
  repository,
  prNumber: 7,
  targetBranch: "dev",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  mergeSha: "c".repeat(40),
};
const writeSha = "d".repeat(40);
const treeSha = "e".repeat(40);
const title = "feat(example): add capability";
const fingerprint = prTitleFingerprint(title);
const runUrl = `https://github.com/${control}/actions/runs/51`;
const ciUrl = `https://github.com/${control}/actions/runs/52`;
const prefix = `repos/${repository}`;

function fixture() {
  const pull = {
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    title,
    base: { ref: "dev", sha: scope.baseSha, repo: { full_name: repository, private: false } },
    head: { ref: "feat/example", sha: scope.headSha, repo: { full_name: repository } },
  };
  const receipts = [
    {
      context: "Dev PR Governance",
      description: devGovernanceReceipt(scope, fingerprint),
      target_url: runUrl,
    },
    {
      context: "validate-merge-dev",
      description: devGovernanceReceipt(scope, fingerprint),
      target_url: runUrl,
    },
    {
      context: "Dev CI Evidence",
      description: prCiScopeDescription(scope),
      target_url: ciUrl,
    },
  ].map((status) => ({ ...status, state: "success", created_at: "2026-11-25T10:00:00Z" }));
  const statusPath = `${prefix}/commits/${scope.headSha}/status`;
  const signed = () => attestFixtureStatuses({ statuses: receipts }, repository, scope.headSha);
  const run = {
    repository: { full_name: control },
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-25T09:50:00Z",
    updated_at: "2026-11-25T10:01:00Z",
  };
  const snapshot = {
    sha: scope.mergeSha,
    tree: { sha: treeSha },
    parents: [{ sha: scope.baseSha }, { sha: scope.headSha }],
  };
  const commit = { sha: writeSha, tree: { sha: treeSha }, parents: [{ sha: scope.baseSha }] };
  const closed = {
    ...pull,
    state: "closed",
    merged: true,
    merged_at: "2026-11-25T10:02:00Z",
    merge_commit_sha: writeSha,
  };
  const entries = new Map<string, unknown>([
    [`${prefix}/pulls/7`, pull],
    [`${prefix}/branches/dev`, { commit: { sha: scope.baseSha } }],
    [`${prefix}/git/ref/pull/7/merge`, { object: { sha: scope.mergeSha } }],
    [`${prefix}/git/commits/${scope.mergeSha}`, snapshot],
    [`${prefix}/git/commits/${writeSha}`, commit],
    [`${prefix}/commits/${writeSha}`, { sha: writeSha, commit: { message: title + " (#7)" } }],
    [`${prefix}/commits/${writeSha}/pulls?per_page=100`, [closed]],
    [statusPath, signed()],
    [
      `repos/${control}/actions/runs/51`,
      { ...run, id: 51, path: ".github/workflows/handle-pr-dispatch.yml" },
    ],
    [
      `repos/${control}/actions/runs/52`,
      { ...run, id: 52, path: ".github/workflows/central-ci-dispatch.yml" },
    ],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path.startsWith(`${prefix}/issues?`)) return [];
      assert.ok(entries.has(path), path);
      return entries.get(path);
    },
  };
  return { entries, reader, receipts, signed, statusPath, pull, closed, commit };
}

test("dev admission binds every gate to the same PR, title and immutable snapshot", async () => {
  const f = fixture();
  const verify = () =>
    verifyDevMergeAdmission(f.reader, repository, 7, scope.headSha, scope.baseSha, runUrl, control);
  assert.deepEqual(await verify(), scope);
  for (const field of ["baseSha", "mergeSha", "headSha"] as const) {
    f.receipts[0]!.description = devGovernanceReceipt(
      { ...scope, [field]: "f".repeat(40) },
      fingerprint
    );
    f.entries.set(f.statusPath, f.signed());
    await assert.rejects(verify(), /current signed governance scope/);
  }
  f.receipts[0]!.description = devGovernanceReceipt(scope, fingerprint);
  f.entries.set(f.statusPath, f.signed());
  f.entries.set(`${prefix}/pulls/7`, { ...f.pull, title: "fix(example): different title" });
  await assert.rejects(verify(), /current signed governance scope/);
  f.entries.set(`${prefix}/pulls/7`, { ...f.pull, draft: true });
  await assert.rejects(verify(), /not eligible/);
  f.entries.set(`${prefix}/pulls/7`, { ...f.pull, base: { ...f.pull.base, ref: "main" } });
  await assert.rejects(verify(), /no longer matches/);
});

test("dev write audit rejects different trees, parents and post-merge evidence", async () => {
  const f = fixture();
  f.entries.set(`${prefix}/pulls/7`, f.closed);
  const verify = () =>
    verifyDevSquashWrite(f.reader, scope, writeSha, fingerprint, runUrl, control);
  await verify();
  for (const commit of [
    { ...f.commit, tree: { sha: "f".repeat(40) } },
    { ...f.commit, parents: [{ sha: "f".repeat(40) }] },
  ]) {
    f.entries.set(`${prefix}/git/commits/${writeSha}`, commit);
    await assert.rejects(verify(), /parent or source tree/);
  }
  f.entries.set(`${prefix}/git/commits/${writeSha}`, f.commit);
  f.receipts[2]!.created_at = "2026-11-25T10:03:00Z";
  f.entries.set(f.statusPath, f.signed());
  await assert.rejects(verify(), /CI must precede merge/);
});

test("recorded development write requires signed receipt and a trusted dev parent", async () => {
  const f = fixture();
  f.entries.set(`${prefix}/pulls/7`, f.closed);
  const path = `${prefix}/commits/${writeSha}/status`;
  const parentPath = `${prefix}/commits/${scope.baseSha}/status`;
  const auditUrl = `https://github.com/${control}/actions/runs/53`;
  const receipt = {
    context: "Dev Merge Receipt",
    state: "success",
    description: `merge-v1=${scope.mergeSha}`,
    target_url: runUrl,
    created_at: "2026-11-25T10:02:01Z",
  };
  const parent = {
    context: "Dev Write Guard",
    state: "success",
    description: prCiScopeDescription(scope),
    target_url: auditUrl,
    created_at: "2026-11-25T09:00:00Z",
  };
  const governance = f.entries.get(`repos/${control}/actions/runs/51`) as Record<string, unknown>;
  f.entries.set(`repos/${control}/actions/runs/51`, {
    ...governance,
    updated_at: "2026-11-25T10:03:00Z",
  });
  f.entries.set(`repos/${control}/actions/runs/53`, {
    ...governance,
    id: 53,
    path: ".github/workflows/intake.yml",
    run_started_at: "2026-11-25T08:59:00Z",
    updated_at: "2026-11-25T09:01:00Z",
  });
  f.entries.set(
    parentPath,
    attestFixtureStatuses({ statuses: [parent] }, repository, scope.baseSha)
  );
  f.entries.set(path, attestFixtureStatuses({ statuses: [receipt] }, repository, writeSha));
  const verify = () =>
    verifyRecordedDevWrite(
      f.reader,
      repository,
      writeSha,
      control,
      Date.parse("2026-11-25T10:10:00Z")
    );
  assert.deepEqual(await verify(), { scope, description: prCiScopeDescription(scope) });
  f.entries.set(path, { statuses: [receipt] });
  await assert.rejects(verify(), /lacks a signed merge receipt/);
  f.entries.set(
    path,
    attestFixtureStatuses(
      { statuses: [{ ...receipt, created_at: "2026-11-25T10:01:00Z" }] },
      repository,
      writeSha
    )
  );
  await assert.rejects(verify(), /must follow the actual write/);
  f.entries.set(path, attestFixtureStatuses({ statuses: [receipt] }, repository, writeSha));
  f.entries.set(
    parentPath,
    attestFixtureStatuses(
      { statuses: [{ ...parent, context: "Main Write Guard" }] },
      repository,
      scope.baseSha
    )
  );
  await assert.rejects(verify(), /lacks trusted Dev Write Guard/);
});
