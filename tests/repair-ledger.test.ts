import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRepairLedgerEvent, createRepairLedgerEntry, repairTaskId } from "../scripts/repair-ledger.ts";

const fingerprint = "a".repeat(64);
const evidence = "b".repeat(64);
const verifiedCi = "c".repeat(64);
const firstHead = "d".repeat(40);
const secondHead = "e".repeat(40);
const now = "2026-11-21T10:00:00Z";

function fixture() {
  return createRepairLedgerEntry("example/project", fingerprint, now);
}

function advanceToRepair() {
  const found = fixture();
  const diagnosed = applyRepairLedgerEvent(found, 0, { kind: "root-cause-verified", evidenceSha256: evidence }, now);
  return applyRepairLedgerEvent(diagnosed, 1, { kind: "repair-created", headSha: firstHead, prNumber: 42 }, now);
}

test("one repository and root cause produce a stable opaque task ID", () => {
  assert.equal(repairTaskId("Example/Project", fingerprint), repairTaskId("example/project", fingerprint));
  assert.notEqual(repairTaskId("example/another", fingerprint), repairTaskId("example/project", fingerprint));
  assert.notEqual(repairTaskId("example/project", "f".repeat(64)), repairTaskId("example/project", fingerprint));
  assert.equal(repairTaskId("example/project", fingerprint).includes("example"), false);
  assert.throws(() => repairTaskId("bad/../repository", fingerprint), /repository/);
  assert.throws(() => repairTaskId("example/project", "raw user issue text"), /SHA-256/);
});

test("stale and skipped transitions never mutate a repair record", () => {
  const entry = fixture();
  assert.throws(() => applyRepairLedgerEvent(entry, 1, { kind: "root-cause-verified", evidenceSha256: evidence }, now), /Stale/);
  assert.throws(() => applyRepairLedgerEvent(entry, 0, { kind: "repair-created", headSha: firstHead, prNumber: 42 }, now), /verified root cause/);
  assert.equal(entry.revision, 0);
  assert.equal(entry.stage, "discovered");
});

test("the next CI run can only verify the current head and matching run", () => {
  const repairing = advanceToRepair();
  assert.throws(() => applyRepairLedgerEvent(repairing, 2, { kind: "ci-started", headSha: secondHead, runId: 5 }, now), /current repair head/);
  const checking = applyRepairLedgerEvent(repairing, 2, { kind: "ci-started", headSha: firstHead, runId: 5 }, now);
  assert.throws(() => applyRepairLedgerEvent(checking, 3, { kind: "ci-verified", headSha: firstHead, runId: 6, evidenceSha256: verifiedCi }, now), /stale/);
  assert.throws(() => applyRepairLedgerEvent(checking, 3, { kind: "ci-verified", headSha: secondHead, runId: 5, evidenceSha256: verifiedCi }, now), /stale/);
  const done = applyRepairLedgerEvent(checking, 3, { kind: "ci-verified", headSha: firstHead, runId: 5, evidenceSha256: verifiedCi }, now);
  assert.equal(done.stage, "completed");
  assert.throws(() => applyRepairLedgerEvent(done, 4, { kind: "head-updated", headSha: secondHead }, now), /immutable/);
});

test("head changes invalidate previously started CI and force a fresh verification", () => {
  const repairing = advanceToRepair();
  const checking = applyRepairLedgerEvent(repairing, 2, { kind: "ci-started", headSha: firstHead, runId: 5 }, now);
  const changed = applyRepairLedgerEvent(checking, 3, { kind: "head-updated", headSha: secondHead }, now);
  assert.deepEqual({ stage: changed.stage, head: changed.head_sha, run: changed.ci_run_id, oldCiHead: changed.ci_head_sha }, {
    stage: "repairing", head: secondHead, run: null, oldCiHead: null,
  });
  assert.throws(() => applyRepairLedgerEvent(changed, 4, { kind: "ci-verified", headSha: firstHead, runId: 5, evidenceSha256: verifiedCi }, now), /stale|different run/);
});

test("block reasons are bounded, resumable and do not store private failure details", () => {
  const entry = fixture();
  const blocked = applyRepairLedgerEvent(entry, 0, { kind: "blocked", reason: "permissions" }, now);
  assert.equal(blocked.blocked_reason, "permissions");
  assert.throws(() => applyRepairLedgerEvent(blocked, 1, { kind: "root-cause-verified", evidenceSha256: evidence }, now), /Blocked/);
  const resumed = applyRepairLedgerEvent(blocked, 1, { kind: "unblocked" }, now);
  assert.equal(resumed.blocked_reason, null);
  assert.equal(applyRepairLedgerEvent(resumed, 2, { kind: "root-cause-verified", evidenceSha256: evidence }, now).stage, "diagnosed");
  assert.equal(JSON.stringify(resumed).includes("example/project"), false);
});
