import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRepairLedgerEvent,
  createRepairLedgerEntry,
  type RepairEvent,
  type RepairLedgerEntry,
  repairTaskId,
} from "../scripts/repair-lifecycle-ledger.ts";

const fingerprint = "a".repeat(64);
const evidence = "b".repeat(64);
const verifiedCi = "c".repeat(64);
const firstHead = "d".repeat(40);
const secondHead = "e".repeat(40);
const baseSha = "f".repeat(40);
const nextBaseSha = "0".repeat(40);
const now = "2026-11-21T10:00:00Z";

function fixture() {
  return createRepairLedgerEntry("example/project", fingerprint, now);
}

function change(record: RepairLedgerEntry, event: RepairEvent) {
  return applyRepairLedgerEvent(record, record.revision, event, now);
}

function reject(record: RepairLedgerEntry, event: RepairEvent, error: RegExp) {
  assert.throws(() => change(record, event), error);
}

function advanceToRepair() {
  const found = fixture();
  const diagnosed = change(found, {
    kind: "root-cause-verified",
    evidenceSha256: evidence,
  });
  return change(diagnosed, {
    kind: "repair-created",
    headSha: firstHead,
    baseSha,
    prNumber: 42,
  });
}

test("one repository and root cause produce a stable opaque task ID", () => {
  const id = repairTaskId("example/project", fingerprint);
  assert.equal(repairTaskId("Example/Project", fingerprint), id);
  assert.notEqual(repairTaskId("example/another", fingerprint), id);
  assert.notEqual(repairTaskId("example/project", "f".repeat(64)), id);
  assert.equal(id.includes("example"), false);
  assert.throws(() => repairTaskId("bad/../repository", fingerprint), /repository/);
  assert.throws(() => repairTaskId("example/project", "raw user issue text"), /SHA-256/);
});

test("stale and skipped transitions never mutate a repair record", () => {
  const entry = fixture();
  const event: RepairEvent = { kind: "root-cause-verified", evidenceSha256: evidence };
  assert.throws(() => applyRepairLedgerEvent(entry, 1, event, now), /Stale/);
  reject(
    entry,
    { kind: "repair-created", headSha: firstHead, baseSha, prNumber: 42 },
    /verified root cause/
  );
  assert.equal(entry.revision, 0);
  assert.equal(entry.stage, "discovered");
});

test("CI is tied to the current head and exact run", () => {
  const repairing = advanceToRepair();
  reject(
    repairing,
    { kind: "ci-started", headSha: secondHead, baseSha, runId: 5 },
    /current repair head/
  );
  reject(
    repairing,
    { kind: "ci-started", headSha: firstHead, baseSha: nextBaseSha, runId: 5 },
    /current repair head/
  );
  const checking = change(repairing, { kind: "ci-started", headSha: firstHead, baseSha, runId: 5 });
  reject(
    checking,
    {
      kind: "ci-verified",
      headSha: firstHead,
      baseSha,
      runId: 6,
      evidenceSha256: verifiedCi,
    },
    /stale/
  );
  reject(
    checking,
    {
      kind: "ci-verified",
      headSha: secondHead,
      baseSha,
      runId: 5,
      evidenceSha256: verifiedCi,
    },
    /stale/
  );
  const done = change(checking, {
    kind: "ci-verified",
    headSha: firstHead,
    baseSha,
    runId: 5,
    evidenceSha256: verifiedCi,
  });
  assert.equal(done.stage, "completed");
  assert.equal(done.root_cause_evidence_sha256, evidence);
  assert.equal(done.ci_evidence_sha256, verifiedCi);
  reject(done, { kind: "head-updated", headSha: secondHead, baseSha: nextBaseSha }, /immutable/);
});

test("changing the head invalidates previously started CI", () => {
  const repairing = advanceToRepair();
  const checking = change(repairing, { kind: "ci-started", headSha: firstHead, baseSha, runId: 5 });
  const updated = change(checking, {
    kind: "head-updated",
    headSha: secondHead,
    baseSha: nextBaseSha,
  });
  assert.equal(updated.stage, "repairing");
  assert.equal(updated.head_sha, secondHead);
  assert.equal(updated.base_sha, nextBaseSha);
  assert.equal(updated.ci_run_id, null);
  assert.equal(updated.ci_head_sha, null);
  assert.equal(updated.ci_base_sha, null);
  reject(
    updated,
    {
      kind: "ci-verified",
      headSha: firstHead,
      baseSha,
      runId: 5,
      evidenceSha256: verifiedCi,
    },
    /stale|different run/
  );
});

test("bounded blocks can resume without exposing private failure details", () => {
  const blocked = change(fixture(), { kind: "blocked", reason: "permissions" });
  assert.equal(blocked.blocked_reason, "permissions");
  reject(blocked, { kind: "root-cause-verified", evidenceSha256: evidence }, /Blocked/);
  const resumed = change(blocked, { kind: "unblocked" });
  assert.equal(resumed.blocked_reason, null);
  assert.equal(
    change(resumed, {
      kind: "root-cause-verified",
      evidenceSha256: evidence,
    }).stage,
    "diagnosed"
  );
  assert.equal(JSON.stringify(resumed).includes("example/project"), false);
});

test("originating failure identity persists across recovery and CI state transitions", () => {
  const entry = createRepairLedgerEntry("example/project", fingerprint, now, {
    runId: 42,
    headSha: firstHead,
  });
  assert.equal(entry.failure_run_id, 42);
  assert.equal(entry.failure_head_sha, firstHead);
  const diagnosed = change(entry, { kind: "root-cause-verified", evidenceSha256: evidence });
  const repairing = change(diagnosed, {
    kind: "repair-created",
    headSha: secondHead,
    baseSha,
    prNumber: 41,
  });
  assert.equal(repairing.failure_run_id, 42);
  assert.equal(repairing.failure_head_sha, firstHead);
  const checking = change(repairing, {
    kind: "ci-started",
    headSha: secondHead,
    baseSha,
    runId: 55,
  });
  assert.equal(checking.failure_run_id, 42);
  assert.equal(checking.failure_head_sha, firstHead);
  assert.equal(checking.head_sha, secondHead);
});

test("initial failure identity is validated and legacy callers remain supported", () => {
  assert.deepEqual(
    [fixture().failure_run_id, fixture().failure_head_sha],
    [null, null]
  );
  assert.throws(
    () => createRepairLedgerEntry("example/project", fingerprint, now, {
      runId: 0,
      headSha: firstHead,
    }),
    /positive integer/
  );
  assert.throws(
    () => createRepairLedgerEntry("example/project", fingerprint, now, {
      runId: 1,
      headSha: "untrusted",
    }),
    /Git commit SHA/
  );
});
