import type { JsonReader } from "./ci-evidence.ts";
import { getJsonString, isJsonRecord } from "./github-api.ts";
import type { RepairLedgerSnapshot, RepairLedgerStore } from "./repair-ledger-store.ts";
import { repairTaskId } from "./repair-lifecycle-ledger.ts";
import { CliError } from "./runtime-command.ts";

const GIT_SHA = /^[a-f0-9]{40}$/;

export type RepairRecoveryKind =
  | "not_found"
  | "blocked"
  | "needs_root_cause"
  | "needs_repair"
  | "needs_ci_run"
  | "verify_ci"
  | "head_updated"
  | "merged_requires_main_ci"
  | "closed_without_merge"
  | "completed";

export type RepairRecoveryResult = {
  readonly kind: RepairRecoveryKind;
  readonly task_id: string;
  readonly revision: number | null;
};

export interface RepairRecoveryRequest {
  readonly repository: string;
  readonly issue_number: number;
  readonly root_cause_sha256: string;
  readonly now: string;
  readonly key: Buffer | null;
}

/** Recover a prior task without creating PRs, executing code, or overriding CI gates. */
export async function recoverRepairLedger(
  store: Pick<RepairLedgerStore, "read" | "compareAndSwap">,
  reader: JsonReader,
  request: RepairRecoveryRequest
): Promise<RepairRecoveryResult> {
  const repository = request.repository.trim().toLowerCase();
  const taskId = repairTaskId(repository, request.root_cause_sha256);
  if (!Number.isSafeInteger(request.issue_number) || request.issue_number <= 0) {
    throw new CliError("Repair recovery issue identity is invalid.", 65);
  }

  const metadata = await reader.get(["repos", repository].join("/"));
  if (
    !isJsonRecord(metadata) ||
    getJsonString(metadata, "full_name").toLowerCase() !== repository ||
    typeof metadata.private !== "boolean" ||
    !getJsonString(metadata, "default_branch")
  ) {
    throw new CliError("Repair recovery repository metadata is invalid.", 65);
  }
  if (metadata.private && request.key === null) {
    throw new CliError("Private repair recovery requires AW_ARTIFACT_KEY.", 77);
  }
  const snapshot = await store.read(
    repository,
    request.issue_number,
    request.root_cause_sha256,
    metadata.private,
    metadata.private ? request.key : null
  );
  if (snapshot === null) {
    return { kind: "not_found", task_id: taskId, revision: null };
  }

  const stage = snapshot.document.entry.stage;
  const revision = snapshot.document.entry.revision;
  const result = (kind: RepairRecoveryKind): RepairRecoveryResult => ({
    kind,
    task_id: taskId,
    revision,
  });

  if (stage === "completed") return result("completed");
  if (snapshot.document.entry.blocked_reason !== null) return result("blocked");
  if (stage === "discovered") return result("needs_root_cause");
  if (stage === "diagnosed") return result("needs_repair");

  const prNumber = snapshot.document.entry.pr_number;
  if (prNumber === null) throw new CliError("Repair recovery has no PR identity.", 65);
  const path = ["repos", repository, "pulls", String(prNumber)].join("/");

  const readPull = async () => {
    const pr = await reader.get(path);
    const head = isJsonRecord(pr) ? getJsonString(pr.head, "sha") : "";
    const base = isJsonRecord(pr) ? getJsonString(pr.base, "ref") : "";
    if (
      !isJsonRecord(pr) ||
      pr.number !== prNumber ||
      !GIT_SHA.test(head) ||
      base !== metadata.default_branch ||
      (pr.state !== "open" && pr.state !== "closed")
    ) {
      throw new CliError("Repair recovery PR identity or base branch changed.", 75);
    }
    return { head, state: pr.state, merged: pr.merged === true };
  };

  const pr = await readPull();
  if (pr.merged) return result("merged_requires_main_ci");
  if (pr.state !== "open") return result("closed_without_merge");

  if (pr.head !== snapshot.document.entry.head_sha) {
    const fresh = await readPull();
    if (fresh.head !== pr.head || fresh.state !== "open" || fresh.merged) {
      throw new CliError("Repair PR changed during recovery.", 75);
    }
    const updated: RepairLedgerSnapshot = await store.compareAndSwap(
      snapshot,
      { kind: "head-updated", headSha: pr.head },
      request.now,
      metadata.private ? request.key : null
    );
    return {
      kind: "head_updated",
      task_id: taskId,
      revision: updated.document.entry.revision,
    };
  }

  return result(stage === "ci_verifying" ? "verify_ci" : "needs_ci_run");
}
