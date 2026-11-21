import type { JsonReader } from "./ci-evidence.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { hasExactRepairIssueMarker } from "./repair-issue-binding.ts";
import {
  RepairLedgerConflictError,
  type RepairLedgerDocument,
  type RepairLedgerStore,
} from "./repair-ledger-store.ts";
import { createRepairLedgerEntry, type RepairStage } from "./repair-lifecycle-ledger.ts";
import { CliError } from "./runtime-command.ts";

const HEAD_SHA = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export interface RepairFinding {
  readonly repository: string;
  readonly issue_number: number;
  readonly failure_run_id: number;
  readonly failure_head_sha: string;
  /** A tentative normalized root-cause identity, NOT proof that it was reproduced. */
  readonly root_cause_sha256: string;
  readonly now: string;
}

export type RepairAdmission = {
  readonly outcome: "created" | "existing";
  readonly task_id: string;
  readonly issue_number: number;
  readonly stage: RepairStage;
};

type AdmissionStore = Pick<RepairLedgerStore, "readByRoot" | "create">;

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Admission only records a discovered task: it cannot verify root cause, run
 * code, start CI or create PRs. Call from a trusted read/write scoped job, not
 * with an untrusted Issue or PR payload as execution instructions.
 */
export async function admitRepairFinding(
  store: AdmissionStore,
  reader: JsonReader,
  finding: RepairFinding,
  key: Buffer | null,
  shouldRequireExactIssueMarker = false
): Promise<RepairAdmission> {
  const repository = finding.repository.trim().toLowerCase();
  if (
    !REPOSITORY.test(repository) ||
    !positive(finding.issue_number) ||
    !positive(finding.failure_run_id) ||
    !HEAD_SHA.test(finding.failure_head_sha) ||
    !FINGERPRINT.test(finding.root_cause_sha256)
  ) {
    throw new CliError("Repair finding identifiers are invalid.", 65);
  }
  const repo = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(repo) ||
    getJsonString(repo, "full_name").toLowerCase() !== repository ||
    typeof repo.private !== "boolean" ||
    !getJsonString(repo, "default_branch")
  ) {
    throw new CliError("Repair finding repository metadata is invalid.", 65);
  }
  const isPrivate = repo.private;
  if (isPrivate && key === null) {
    throw new CliError("Private repair finding requires AW_ARTIFACT_KEY.", 77);
  }

  // No claim of a root cause is accepted from an Issue title, model answer,
  // HTTP result, or a failed dispatch alone. Only a completed real failed
  // GitHub Actions workflow is eligible to enter the discovered stage.
  const run = await reader.get(`repos/${repository}/actions/runs/${finding.failure_run_id}`);
  if (
    !isJsonRecord(run) ||
    getJsonNumber(run, "id") !== finding.failure_run_id ||
    getJsonString(run.repository, "full_name").toLowerCase() !== repository ||
    getJsonString(run, "head_sha") !== finding.failure_head_sha ||
    getJsonString(run, "status") !== "completed" ||
    (getJsonString(run, "conclusion") !== "failure" &&
      getJsonString(run, "conclusion") !== "timed_out") ||
    !getJsonString(run, "path")
  ) {
    throw new CliError("Repair finding has no matching failed Actions run.", 75);
  }

  const issue = await reader.get(`repos/${repository}/issues/${finding.issue_number}`);
  if (
    !isJsonRecord(issue) ||
    getJsonNumber(issue, "number") !== finding.issue_number ||
    getJsonString(issue, "state") !== "open" ||
    issue.pull_request !== undefined
  ) {
    throw new CliError("Repair finding must refer to an existing open Issue.", 75);
  }
  if (
    shouldRequireExactIssueMarker &&
    !hasExactRepairIssueMarker(issue.body, finding.failure_run_id, finding.failure_head_sha)
  ) {
    throw new CliError("Repair Issue failure marker changed before admission.", 75);
  }

  const protectedKey = isPrivate ? key : null;
  const current = await store.readByRoot(
    repository,
    finding.root_cause_sha256,
    isPrivate,
    protectedKey
  );
  const admission = (
    record: RepairLedgerDocument,
    outcome: "created" | "existing"
  ): RepairAdmission => ({
    outcome,
    task_id: record.entry.task_id,
    issue_number: record.issue_number,
    stage: record.entry.stage,
  });
  if (current !== null) return admission(current.document, "existing");
  const record: RepairLedgerDocument = {
    schema_version: "1",
    repository,
    issue_number: finding.issue_number,
    entry: createRepairLedgerEntry(repository, finding.root_cause_sha256, finding.now, {
      runId: finding.failure_run_id,
      headSha: finding.failure_head_sha,
    }),
  };
  try {
    const created = await store.create(record, isPrivate, protectedKey);
    return admission(created.document, "created");
  } catch (error) {
    if (!(error instanceof RepairLedgerConflictError)) throw error;
    // A parallel worker won the initial Git Ref creation. Re-read the winning
    // record; do not overwrite it or create a second PR/Issue.
    const winner = await store.readByRoot(
      repository,
      finding.root_cause_sha256,
      isPrivate,
      protectedKey
    );
    if (winner === null) throw error;
    return admission(winner.document, "existing");
  }
}
