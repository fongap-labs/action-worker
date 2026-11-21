import assert from "node:assert/strict";
import { test } from "node:test";
import { admitRepairFinding, type RepairFinding } from "../scripts/repair-finding-admission.ts";
import {
  RepairLedgerConflictError,
  type RepairLedgerDocument,
  type RepairLedgerSnapshot,
} from "../scripts/repair-ledger-store.ts";
import { applyRepairLedgerEvent } from "../scripts/repair-lifecycle-ledger.ts";

const repository = "example/project";
const root = "a".repeat(64);
const head = "b".repeat(40);
const timestamp = "2026-11-21T11:00:00Z";

function finding(issueNumber = 17): RepairFinding {
  return {
    repository,
    issue_number: issueNumber,
    failure_run_id: 42,
    failure_head_sha: head,
    root_cause_sha256: root,
    now: timestamp,
  };
}

function gh(
  options: {
    isPrivate?: boolean;
    runConclusion?: string;
    runStatus?: string;
    runHead?: string;
    runRepo?: string;
    issueState?: string;
    isPull?: boolean;
    badRepo?: boolean;
  } = {}
) {
  return {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}`) {
        return {
          full_name: options.badRepo ? "other/repository" : repository,
          default_branch: "main",
          private: options.isPrivate ?? false,
        };
      }
      if (path === `repos/${repository}/actions/runs/42`) {
        return {
          id: 42,
          status: options.runStatus ?? "completed",
          conclusion: options.runConclusion ?? "failure",
          path: ".github/workflows/ci.yml",
          head_sha: options.runHead ?? head,
          repository: { full_name: options.runRepo ?? repository },
        };
      }
      if (path.startsWith(`repos/${repository}/issues/`)) {
        return {
          number: Number(path.split("/").at(-1)),
          state: options.issueState ?? "open",
          ...(options.isPull ? { pull_request: { url: "private" } } : {}),
        };
      }
      throw new Error("Unexpected GitHub request.");
    },
  };
}

class FakeStore {
  readonly documents = new Map<string, RepairLedgerDocument>();
  writes = 0;
  public lastPrivate = false;
  public lastKey: Buffer | null = null;
  public conflictOnCreate = false;

  async readByRoot(
    source: string,
    fingerprint: string,
    isPrivate: boolean,
    key: Buffer | null
  ): Promise<RepairLedgerSnapshot | null> {
    assert.equal(source, repository);
    assert.equal(fingerprint, root);
    this.lastPrivate = isPrivate;
    this.lastKey = key;
    const record = this.documents.get(fingerprint);
    return record
      ? {
          document: record,
          commit_sha: "e".repeat(40),
          tree_sha: "f".repeat(40),
          is_private: isPrivate,
        }
      : null;
  }

  async create(
    document: RepairLedgerDocument,
    isPrivate: boolean,
    key: Buffer | null
  ): Promise<RepairLedgerSnapshot> {
    this.writes += 1;
    assert.equal(isPrivate, this.lastPrivate);
    assert.equal(key, this.lastKey);
    if (this.conflictOnCreate) {
      this.conflictOnCreate = false;
      this.documents.set(document.entry.root_cause_sha256, document);
      throw new RepairLedgerConflictError();
    }
    if (this.documents.has(document.entry.root_cause_sha256)) throw new RepairLedgerConflictError();
    this.documents.set(document.entry.root_cause_sha256, document);
    return {
      document,
      commit_sha: "e".repeat(40),
      tree_sha: "f".repeat(40),
      is_private: isPrivate,
    };
  }
}

test("completed failed run creates one discovered task, not an asserted diagnosis", async () => {
  const store = new FakeStore();
  const admitted = await admitRepairFinding(store, gh(), finding(), null);
  assert.equal(admitted.outcome, "created");
  assert.equal(admitted.stage, "discovered");
  assert.equal(admitted.issue_number, 17);
  assert.equal(store.writes, 1);
  assert.equal(store.documents.get(root)?.entry.root_cause_evidence_sha256, null);
});

test("the same root in a different Issue reuses the original task and Issue", async () => {
  const store = new FakeStore();
  const first = await admitRepairFinding(store, gh(), finding(17), null);
  const replay = await admitRepairFinding(store, gh(), finding(23), null);
  assert.equal(replay.outcome, "existing");
  assert.equal(replay.task_id, first.task_id);
  assert.equal(replay.issue_number, 17);
  assert.equal(store.writes, 1);
  const record = store.documents.get(root);
  assert.ok(record);
  const diagnosed = applyRepairLedgerEvent(
    record.entry,
    0,
    { kind: "root-cause-verified", evidenceSha256: "c".repeat(64) },
    timestamp
  );
  store.documents.set(root, { ...record, entry: diagnosed });
  const again = await admitRepairFinding(store, gh(), finding(29), null);
  assert.equal(again.stage, "diagnosed");
  assert.equal(store.writes, 1);
});

test("concurrent initial Git Ref creation returns the winning record without overwriting", async () => {
  const store = new FakeStore();
  store.conflictOnCreate = true;
  const admitted = await admitRepairFinding(store, gh(), finding(), null);
  assert.equal(admitted.outcome, "existing");
  assert.equal(store.writes, 1);
});

test("no matching failed Actions run means no ledger creation", async () => {
  for (const options of [
    { runStatus: "in_progress" },
    { runConclusion: "success" },
    { runConclusion: "cancelled" },
    { runHead: "d".repeat(40) },
    { runRepo: "other/repository" },
    { issueState: "closed" },
    { isPull: true },
    { badRepo: true },
  ]) {
    const store = new FakeStore();
    await assert.rejects(admitRepairFinding(store, gh(options), finding(), null));
    assert.equal(store.writes, 0);
  }
});

test("private records require the existing encryption key and remain private", async () => {
  const store = new FakeStore();
  await assert.rejects(
    admitRepairFinding(store, gh({ isPrivate: true }), finding(), null),
    /AW_ARTIFACT_KEY/
  );
  const key = Buffer.alloc(32, 7);
  await admitRepairFinding(store, gh({ isPrivate: true }), finding(), key);
  assert.equal(store.lastPrivate, true);
  assert.equal(store.lastKey, key);
});

test("malformed and mismatched candidate identifiers are rejected before API calls", async () => {
  const store = new FakeStore();
  for (const invalid of [
    { ...finding(), root_cause_sha256: "unverified textual root cause" },
    { ...finding(), failure_head_sha: "wrong-sha" },
    { ...finding(), failure_run_id: 0 },
    { ...finding(), issue_number: -1 },
    { ...finding(), repository: "bad/../source" },
  ]) {
    await assert.rejects(admitRepairFinding(store, gh(), invalid, null), /identifiers/);
  }
  assert.equal(store.writes, 0);
});
