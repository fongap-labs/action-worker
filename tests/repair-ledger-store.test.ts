import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createScopedRepairLedgerStore,
  RepairLedgerConflictError,
  type RepairLedgerDocument,
  type RepairLedgerGitApi,
  RepairLedgerStore,
  repairLedgerRefName,
} from "../scripts/repair-ledger-store.ts";
import {
  createRepairLedgerEntry,
  type RepairLedgerEntry,
} from "../scripts/repair-lifecycle-ledger.ts";

const fingerprint = "a".repeat(64);
const rootEvidence = "b".repeat(64);
const ciEvidence = "c".repeat(64);
const head = "d".repeat(40);
const baseSha = "e".repeat(40);
const now = "2026-11-21T10:00:00Z";
const key = Buffer.alloc(32, 9);

class MemoryGitApi implements RepairLedgerGitApi {
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, { tree: string; parent: string | null }>();
  readonly trees = new Map<string, Map<string, string>>();
  private sequence = 0;

  async getRef(refName: string): Promise<string | null> {
    return this.refs.get(refName) ?? null;
  }

  async getCommitTree(commitSha: string): Promise<string> {
    const commit = this.commits.get(commitSha);
    if (!commit) throw new Error("missing commit");
    return commit.tree;
  }

  async getFile(path: string, commitSha: string): Promise<string> {
    const commit = this.commits.get(commitSha);
    const content = commit ? this.trees.get(commit.tree)?.get(path) : undefined;
    if (content === undefined) throw new Error("missing file");
    return content;
  }

  async createTree(baseTreeSha: string | null, path: string, content: string): Promise<string> {
    const files = new Map(baseTreeSha ? this.trees.get(baseTreeSha) : undefined);
    files.set(path, content);
    const sha = createHash("sha1")
      .update(JSON.stringify([...files]))
      .digest("hex");
    this.trees.set(sha, files);
    return sha;
  }

  async createCommit(treeSha: string, parentSha: string | null): Promise<string> {
    const sha = createHash("sha1")
      .update(String(++this.sequence) + treeSha + (parentSha ?? "root"))
      .digest("hex");
    this.commits.set(sha, { tree: treeSha, parent: parentSha });
    return sha;
  }

  async createRef(refName: string, commitSha: string): Promise<void> {
    if (this.refs.has(refName)) throw new RepairLedgerConflictError();
    this.refs.set(refName, commitSha);
  }

  async updateRef(refName: string, commitSha: string): Promise<void> {
    const current = this.refs.get(refName);
    const next = this.commits.get(commitSha);
    if (current === undefined || next?.parent !== current) throw new RepairLedgerConflictError();
    this.refs.set(refName, commitSha);
  }

  async rawRecord(refName: string): Promise<string> {
    const commitSha = this.refs.get(refName);
    assert.ok(commitSha);
    return this.getFile("record.dat", commitSha);
  }
}

function document(
  repository = "internal-vault/market-brief",
  issueNumber = 17,
  entry: RepairLedgerEntry = createRepairLedgerEntry(repository, fingerprint, now)
): RepairLedgerDocument {
  return { schema_version: "1", repository, issue_number: issueNumber, entry };
}

test("public ledger survives reads and revisions in a permanent per-root-cause Git ref", async () => {
  const api = new MemoryGitApi();
  const store = new RepairLedgerStore(api);
  const initial = document("fongap-labs/action-worker", 17);
  const created = await store.create(initial, false, null);
  assert.equal(created.document.entry.revision, 0);
  assert.equal(
    repairLedgerRefName(initial.entry.task_id),
    `repair-ledger-${initial.entry.task_id.slice(7)}`
  );
  assert.equal(repairLedgerRefName(initial.entry.task_id).includes("fongap-labs"), false);

  const restored = await store.read(initial.repository, 17, fingerprint, false, null);
  assert.deepEqual(restored?.document, initial);
  assert.equal(restored?.commit_sha, created.commit_sha);

  const updated = await store.compareAndSwap(
    created,
    { kind: "root-cause-verified", evidenceSha256: rootEvidence },
    now,
    null
  );
  assert.equal(updated.document.entry.revision, 1);
  assert.equal(updated.document.entry.root_cause_evidence_sha256, rootEvidence);
  const resumed = await store.read(initial.repository, 17, fingerprint, false, null);
  assert.equal(resumed?.document.entry.stage, "diagnosed");
  assert.equal(resumed?.commit_sha, updated.commit_sha);
});

test("private ledger records encrypt repository, issue and evidence before writing public refs", async () => {
  const api = new MemoryGitApi();
  const store = new RepairLedgerStore(api);
  const initial = document();
  const created = await store.create(initial, true, key);
  const raw = await api.rawRecord(repairLedgerRefName(initial.entry.task_id));
  assert.match(raw, /^AWREPAIR1:sealed:/);
  assert.equal(raw.includes(initial.repository), false);
  // Random Base64 ciphertext can contain short decimal substrings by chance.
  // Check that the complete plaintext field is absent instead.
  assert.equal(raw.includes(`"issue_number":${initial.issue_number}`), false);
  assert.equal(raw.includes(fingerprint), false);
  assert.equal(raw.includes(initial.entry.task_id), false);

  const restored = await store.read(
    initial.repository,
    initial.issue_number,
    fingerprint,
    true,
    key
  );
  assert.deepEqual(restored?.document, initial);
  await assert.rejects(
    store.read(initial.repository, initial.issue_number, fingerprint, true, Buffer.alloc(32, 8)),
    /does not belong/
  );
  await assert.rejects(
    store.read(initial.repository, initial.issue_number, fingerprint, true, null),
    /visibility or key/
  );
  await assert.rejects(
    store.read(initial.repository, initial.issue_number, fingerprint, false, null),
    /unexpected encrypted envelope/
  );
  assert.equal(created.is_private, true);
});

test("concurrent updates and duplicate creation fail closed without losing the winning revision", async () => {
  const api = new MemoryGitApi();
  const store = new RepairLedgerStore(api);
  const initial = document("fongap-labs/action-worker", 19);
  const first = await store.create(initial, false, null);
  await assert.rejects(store.create(initial, false, null), RepairLedgerConflictError);

  const secondReader = await store.read(initial.repository, 19, fingerprint, false, null);
  assert.ok(secondReader);
  const saved = await store.compareAndSwap(
    first,
    { kind: "root-cause-verified", evidenceSha256: rootEvidence },
    now,
    null
  );
  await assert.rejects(
    store.compareAndSwap(
      secondReader,
      { kind: "root-cause-verified", evidenceSha256: ciEvidence },
      now,
      null
    ),
    RepairLedgerConflictError
  );
  const final = await store.read(initial.repository, 19, fingerprint, false, null);
  assert.equal(final?.commit_sha, saved.commit_sha);
  assert.equal(final?.document.entry.root_cause_evidence_sha256, rootEvidence);
});

test("ledger refuses wrong issue and cannot complete without trusted CI verification", async () => {
  const api = new MemoryGitApi();
  const store = new RepairLedgerStore(api);
  const initial = document("fongap-labs/action-worker", 21);
  const created = await store.create(initial, false, null);
  await assert.rejects(
    store.read(initial.repository, 22, fingerprint, false, null),
    /different issue/
  );
  const existingRoot = await store.readByRoot(initial.repository, fingerprint, false, null);
  assert.equal(existingRoot?.document.issue_number, 21);
  assert.equal(existingRoot?.document.entry.task_id, initial.entry.task_id);
  await assert.rejects(
    store.compareAndSwap(
      created,
      { kind: "repair-created", headSha: head, baseSha, prNumber: 44 },
      now,
      null
    ),
    /verified root cause/
  );
  await assert.rejects(
    store.compareAndSwap(
      created,
      { kind: "ci-verified", headSha: head, baseSha, runId: 45, evidenceSha256: ciEvidence },
      now,
      null
    ),
    /trusted current-head GitHub CI verification/
  );
});

test("private task state cannot be created without its existing protected artifact key", async () => {
  const store = new RepairLedgerStore(new MemoryGitApi());
  const initial = document();
  await assert.rejects(store.create(initial, true, null), /requires AW_ARTIFACT_KEY/);
});

test("scoped store requires its dedicated branch token and current control repository", () => {
  assert.throws(
    () =>
      createScopedRepairLedgerStore("fongap-labs/action-worker", {
        GITHUB_REPOSITORY: "fongap-labs/action-worker",
        GH_TOKEN: "must-not-fallback",
      } as NodeJS.ProcessEnv),
    /AW_BRANCH_API_TOKEN/
  );
  assert.throws(
    () =>
      createScopedRepairLedgerStore("fongap-labs/other", {
        GITHUB_REPOSITORY: "fongap-labs/action-worker",
        AW_BRANCH_API_TOKEN: "scoped-token",
      } as NodeJS.ProcessEnv),
    /current control repository/
  );
});
