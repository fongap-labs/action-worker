import { createHash } from "node:crypto";

const SHA_256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type RepairStage = "discovered" | "diagnosed" | "repairing" | "ci_verifying" | "completed";
export type RepairBlock =
  | "missing_evidence"
  | "permissions"
  | "quota"
  | "stale_head"
  | "ci_failure";

/** An intentionally non-secret, bounded projection. Raw logs and private paths stay at source. */
export interface RepairLedgerEntry {
  readonly task_id: string;
  readonly root_cause_sha256: string;
  /** Verified failed workflow origin; null only for legacy records. */
  readonly failure_run_id: number | null;
  readonly failure_head_sha: string | null;
  readonly revision: number;
  readonly stage: RepairStage;
  readonly root_cause_evidence_sha256: string | null;
  readonly ci_evidence_sha256: string | null;
  readonly head_sha: string | null;
  readonly base_sha: string | null;
  readonly pr_number: number | null;
  readonly ci_run_id: number | null;
  readonly ci_head_sha: string | null;
  readonly ci_base_sha: string | null;
  readonly blocked_reason: RepairBlock | null;
  readonly updated_at: string;
}

export type RepairEvent =
  | { kind: "root-cause-verified"; evidenceSha256: string }
  | { kind: "repair-created"; headSha: string; baseSha: string; prNumber: number }
  | { kind: "ci-started"; headSha: string; baseSha: string; runId: number }
  | { kind: "ci-verified"; headSha: string; baseSha: string; runId: number; evidenceSha256: string }
  | { kind: "head-updated"; headSha: string; baseSha: string }
  | { kind: "blocked"; reason: RepairBlock }
  | { kind: "unblocked" };

function assertDigest(value: string): void {
  if (!SHA_256.test(value)) throw new Error("Expected a lowercase SHA-256 evidence fingerprint.");
}

function assertHead(value: string): void {
  if (!GIT_SHA.test(value)) throw new Error("Expected an immutable lowercase Git commit SHA.");
}

function assertPositive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Expected a positive integer identifier.");
}

function assertTime(value: string): void {
  if (!UTC_TIME.test(value) || Number.isNaN(Date.parse(value)))
    throw new Error("Expected a UTC timestamp.");
}

export function repairTaskId(repository: string, rootCauseSha256: string): string {
  const normalized = repository.trim().toLowerCase();
  if (!REPOSITORY.test(normalized)) throw new Error("Invalid repository identifier.");
  assertDigest(rootCauseSha256);
  const digest = createHash("sha256")
    .update(`${normalized}\0${rootCauseSha256}`, "utf8")
    .digest("hex");
  return `repair-${digest.slice(0, 32)}`;
}

export function createRepairLedgerEntry(
  repository: string,
  rootCauseSha256: string,
  now: string,
  failure?: { readonly runId: number; readonly headSha: string }
): RepairLedgerEntry {
  assertTime(now);
  if (failure !== undefined) {
    assertPositive(failure.runId);
    assertHead(failure.headSha);
  }
  return {
    task_id: repairTaskId(repository, rootCauseSha256),
    root_cause_sha256: rootCauseSha256,
    failure_run_id: failure?.runId ?? null,
    failure_head_sha: failure?.headSha ?? null,
    revision: 0,
    stage: "discovered",
    root_cause_evidence_sha256: null,
    ci_evidence_sha256: null,
    head_sha: null,
    base_sha: null,
    pr_number: null,
    ci_run_id: null,
    ci_head_sha: null,
    ci_base_sha: null,
    blocked_reason: null,
    updated_at: now,
  };
}

/** Pure revision check. The caller must persist updates using a real atomic compare-and-swap. */
export function applyRepairLedgerEvent(
  current: RepairLedgerEntry,
  expectedRevision: number,
  event: RepairEvent,
  now: string
): RepairLedgerEntry {
  assertTime(now);
  if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
    throw new Error("Stale repair ledger revision.");
  }
  if (Date.parse(now) < Date.parse(current.updated_at))
    throw new Error("Repair ledger clock moved backwards.");
  if (current.stage === "completed") throw new Error("Completed repair records are immutable.");
  if (current.blocked_reason !== null && event.kind !== "unblocked") {
    throw new Error("Blocked repair requires an explicit unblock before continuing.");
  }
  let change: Partial<RepairLedgerEntry>;
  switch (event.kind) {
    case "root-cause-verified":
      if (current.stage !== "discovered")
        throw new Error("Root cause already verified or task has advanced.");
      assertDigest(event.evidenceSha256);
      change = { stage: "diagnosed", root_cause_evidence_sha256: event.evidenceSha256 };
      break;
    case "repair-created":
      if (current.stage !== "diagnosed") throw new Error("Repair requires verified root cause.");
      assertHead(event.headSha);
      assertHead(event.baseSha);
      assertPositive(event.prNumber);
      change = {
        stage: "repairing",
        head_sha: event.headSha,
        base_sha: event.baseSha,
        pr_number: event.prNumber,
      };
      break;
    case "ci-started":
      if (
        current.stage !== "repairing" ||
        event.headSha !== current.head_sha ||
        event.baseSha !== current.base_sha
      ) {
        throw new Error("CI must test the current repair head.");
      }
      assertPositive(event.runId);
      assertHead(event.baseSha);
      change = {
        stage: "ci_verifying",
        ci_run_id: event.runId,
        ci_head_sha: event.headSha,
        ci_base_sha: event.baseSha,
      };
      break;
    case "ci-verified":
      if (
        current.stage !== "ci_verifying" ||
        event.headSha !== current.head_sha ||
        event.baseSha !== current.base_sha ||
        event.headSha !== current.ci_head_sha ||
        event.baseSha !== current.ci_base_sha ||
        event.runId !== current.ci_run_id
      ) {
        throw new Error("CI evidence is stale or belongs to a different run.");
      }
      // Only a trusted, SHA-bound GitHub status verifier may emit ci-verified.
      assertDigest(event.evidenceSha256);
      change = { stage: "completed", ci_evidence_sha256: event.evidenceSha256 };
      break;
    case "head-updated":
      if (current.stage !== "repairing" && current.stage !== "ci_verifying") {
        throw new Error("Head updates require an existing repair.");
      }
      assertHead(event.headSha);
      assertHead(event.baseSha);
      if (event.headSha === current.head_sha && event.baseSha === current.base_sha) {
        throw new Error("Repair head and base SHAs did not change.");
      }
      change = {
        stage: "repairing",
        head_sha: event.headSha,
        base_sha: event.baseSha,
        ci_run_id: null,
        ci_head_sha: null,
        ci_base_sha: null,
      };
      break;
    case "blocked":
      change = { blocked_reason: event.reason };
      break;
    case "unblocked":
      if (current.blocked_reason === null) throw new Error("Task is not blocked.");
      change = { blocked_reason: null };
      break;
  }
  return { ...current, ...change, revision: current.revision + 1, updated_at: now };
}
