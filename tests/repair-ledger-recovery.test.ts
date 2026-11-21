import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverRepairLedger } from "../scripts/repair-ledger-recovery.ts";
import {
  RepairLedgerConflictError,
  type RepairLedgerDocument,
  type RepairLedgerSnapshot,
} from "../scripts/repair-ledger-store.ts";
import {
  applyRepairLedgerEvent,
  createRepairLedgerEntry,
  type RepairEvent,
  type RepairLedgerEntry,
} from "../scripts/repair-lifecycle-ledger.ts";

const repository = "example/project";
const rootCause = "a".repeat(64);
const evidence = "b".repeat(64);
const firstHead = "c".repeat(40);
const secondHead = "d".repeat(40);
const firstBase = "e".repeat(40);
const secondBase = "f".repeat(40);
const now = "2026-11-21T11:00:00Z";

function progress(stage: "discovered" | "diagnosed" | "repairing" | "ci_verifying") {
  let entry = createRepairLedgerEntry(repository, rootCause, now);
  if (stage === "discovered") return entry;
  entry = applyRepairLedgerEvent(
    entry,
    entry.revision,
    { kind: "root-cause-verified", evidenceSha256: evidence },
    now
  );
  if (stage === "diagnosed") return entry;
  entry = applyRepairLedgerEvent(
    entry,
    entry.revision,
    { kind: "repair-created", headSha: firstHead, baseSha: firstBase, prNumber: 12 },
    now
  );
  if (stage === "repairing") return entry;
  return applyRepairLedgerEvent(
    entry,
    entry.revision,
    { kind: "ci-started", headSha: firstHead, baseSha: firstBase, runId: 88 },
    now
  );
}

class FakeStore {
  snapshot: RepairLedgerSnapshot | null;
  writes = 0;
  wasPrivate = false;
  key: Buffer | null = null;
  conflict = false;

  constructor(entry: RepairLedgerEntry | null) {
    this.snapshot = entry
      ? {
          document: {
            schema_version: "1",
            repository,
            issue_number: 19,
            entry,
          },
          commit_sha: "e".repeat(40),
          tree_sha: "f".repeat(40),
          is_private: false,
        }
      : null;
  }

  async read(
    source: string,
    issue: number,
    fingerprint: string,
    isPrivate: boolean,
    key: Buffer | null
  ): Promise<RepairLedgerSnapshot | null> {
    assert.equal(source, repository);
    assert.equal(issue, 19);
    assert.equal(fingerprint, rootCause);
    this.wasPrivate = isPrivate;
    this.key = key;
    return this.snapshot;
  }

  async compareAndSwap(
    old: RepairLedgerSnapshot,
    event: RepairEvent,
    timestamp: string,
    key: Buffer | null
  ): Promise<RepairLedgerSnapshot> {
    assert.equal(key, this.key);
    if (this.conflict || old !== this.snapshot) throw new RepairLedgerConflictError();
    this.writes += 1;
    const nextEntry = applyRepairLedgerEvent(
      old.document.entry,
      old.document.entry.revision,
      event,
      timestamp
    );
    const nextDoc: RepairLedgerDocument = { ...old.document, entry: nextEntry };
    this.snapshot = { ...old, document: nextDoc };
    return this.snapshot;
  }
}

function reader(
  options: {
    private?: boolean;
    head?: string;
    state?: "open" | "closed";
    merged?: boolean;
    defaultBranch?: string;
    changedHead?: string;
    baseSha?: string;
    changedBase?: string;
    wrongRepo?: boolean;
    wrongBase?: boolean;
  } = {}
) {
  let reads = 0;
  return {
    async get(path: string): Promise<unknown> {
      if (path === "repos/example/project") {
        return {
          full_name: options.wrongRepo ? "example/another" : repository,
          private: options.private ?? false,
          default_branch: options.defaultBranch ?? "main",
        };
      }
      if (path === "repos/example/project/pulls/12") {
        reads += 1;
        return {
          number: 12,
          state: options.state ?? "open",
          merged: options.merged ?? false,
          head: {
            sha:
              reads > 1 && options.changedHead ? options.changedHead : (options.head ?? firstHead),
          },
          base: {
            ref: options.wrongBase ? "other" : (options.defaultBranch ?? "main"),
            sha: reads > 1 && options.changedBase ? options.changedBase : (options.baseSha ?? firstBase),
          },
        };
      }
      throw new Error("Unexpected GitHub query.");
    },
  };
}

function recover(store: FakeStore, gh = reader(), key: Buffer | null = null) {
  return recoverRepairLedger(store, gh, {
    repository,
    issue_number: 19,
    root_cause_sha256: rootCause,
    key,
    now,
  });
}

test("duplicate delivery reuses one stable task without creating any issue or PR", async () => {
  const store = new FakeStore(null);
  const a = await recover(store);
  const b = await recover(store);
  assert.deepEqual(a, b);
  assert.equal(a.kind, "not_found");
  assert.equal(store.writes, 0);

  const active = new FakeStore(progress("diagnosed"));
  assert.equal((await recover(active)).kind, "needs_repair");
  assert.equal((await recover(active)).kind, "needs_repair");
  assert.equal(active.writes, 0);
});

test("stages resume deterministically without rewriting existing ledger records", async () => {
  assert.equal((await recover(new FakeStore(progress("discovered")))).kind, "needs_root_cause");
  assert.equal((await recover(new FakeStore(progress("repairing")))).kind, "needs_ci_run");
  assert.equal((await recover(new FakeStore(progress("ci_verifying")))).kind, "verify_ci");
});

test("PR head changes invalidate old CI exactly once and are durably resumable", async () => {
  const store = new FakeStore(progress("ci_verifying"));
  const gh = reader({ head: secondHead });
  const changed = await recover(store, gh);
  assert.equal(changed.kind, "head_updated");
  assert.equal(changed.revision, 4);
  assert.equal(store.writes, 1);
  assert.equal(store.snapshot?.document.entry.head_sha, secondHead);
  assert.equal(store.snapshot?.document.entry.ci_run_id, null);
  assert.equal(store.snapshot?.document.entry.ci_head_sha, null);
  assert.equal(store.snapshot?.document.entry.ci_base_sha, null);
  assert.equal((await recover(store, reader({ head: secondHead }))).kind, "needs_ci_run");
  assert.equal(store.writes, 1);
});

test("merged PRs never turn into completed tasks on stale PR-level CI", async () => {
  for (const stage of ["repairing", "ci_verifying"] as const) {
    const store = new FakeStore(progress(stage));
    assert.equal(
      (await recover(store, reader({ state: "closed", merged: true, head: secondHead }))).kind,
      "merged_requires_main_ci"
    );
    assert.equal(
      (await recover(store, reader({ state: "closed", merged: false }))).kind,
      "closed_without_merge"
    );
    assert.equal(store.writes, 0);
  }
});

test("blocked and completed tasks do not reopen themselves", async () => {
  const blocked = applyRepairLedgerEvent(
    progress("repairing"),
    2,
    { kind: "blocked", reason: "permissions" },
    now
  );
  const store = new FakeStore(blocked);
  assert.equal((await recover(store)).kind, "blocked");
  assert.equal(store.writes, 0);
});

test("visibility comes from GitHub metadata; private records require encryption key", async () => {
  const store = new FakeStore(progress("discovered"));
  await assert.rejects(recover(store, reader({ private: true })), /AW_ARTIFACT_KEY/);
  const key = Buffer.alloc(32, 7);
  assert.equal((await recover(store, reader({ private: true }), key)).kind, "needs_root_cause");
  assert.equal(store.wasPrivate, true);
  assert.equal(store.key, key);
  await assert.rejects(recover(store, reader({ wrongRepo: true })), /metadata is invalid/);
});

test("wrong PR base, concurrent head changes and write conflicts fail closed", async () => {
  const store = new FakeStore(progress("ci_verifying"));
  await assert.rejects(recover(store, reader({ wrongBase: true })), /identity or base/);
  await assert.rejects(
    recover(store, reader({ head: secondHead, changedHead: "f".repeat(40) })),
    /changed during recovery/
  );
  store.conflict = true;
  await assert.rejects(recover(store, reader({ head: secondHead })), RepairLedgerConflictError);
  assert.equal(store.writes, 0);
});

test("repository default branch is read dynamically, not assumed to be main", async () => {
  const store = new FakeStore(progress("repairing"));
  assert.equal((await recover(store, reader({ defaultBranch: "stable" }))).kind, "needs_ci_run");
});

test("base SHA changes invalidate previously verified CI even with unchanged head", async () => {
  const store = new FakeStore(progress("ci_verifying"));
  const updated = await recover(store, reader({ baseSha: secondBase }));
  assert.equal(updated.kind, "head_updated");
  assert.equal(store.snapshot?.document.entry.base_sha, secondBase);
  assert.equal(store.snapshot?.document.entry.ci_head_sha, null);
  assert.equal(store.snapshot?.document.entry.ci_base_sha, null);
  assert.equal((await recover(store, reader({ baseSha: secondBase }))).kind, "needs_ci_run");
  assert.equal(store.writes, 1);
});

test("PR base changes during recovery fail closed", async () => {
  const store = new FakeStore(progress("ci_verifying"));
  await assert.rejects(recover(store, reader({ baseSha: secondBase, changedBase: firstBase })), /changed during recovery/);
  assert.equal(store.writes, 0);
});
