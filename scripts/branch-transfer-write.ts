import { verifyStagedTransferProof } from "./branch-transfer-staging.ts";
import { hasVerifiedControlStatus, type JsonReader, trustedControlRunId } from "./ci-evidence.ts";
import { type PrCiScope, prCiScopeDescription } from "./ci-scope-receipt.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import type { ManagedBranch } from "./managed-branch-provenance.ts";
import { isManagedTransferDirection, isStagedTransferDirection } from "./resolve-pr-facts.ts";
import { CliError } from "./runtime-command.ts";
import {
  latestAttestedStatus,
  originalStatusDescription,
  statusRunAttempt,
} from "./status-attestation.ts";

const shaPattern = /^[0-9a-f]{40}$/;
export const transferWorkflowPath = ".github/workflows/authorize-branch-transfer.yml";
export class TransferWritePendingError extends CliError {}

export function transferGateContext(branch: string): string {
  if (branch === "main") return "validate-merge";
  if (branch === "dev") return "validate-merge-dev";
  throw new CliError("Invalid transfer target branch.", 65);
}

export function transferReceiptContext(branch: string): string {
  if (branch === "main") return "Main Transfer Receipt";
  if (branch === "dev") return "Dev Transfer Receipt";
  throw new CliError("Invalid transfer target branch.", 65);
}

export function verifyTransferCommit(
  scope: PrCiScope,
  writeSha: string,
  pull: unknown,
  commit: unknown,
  snapshot: unknown
): void {
  prCiScopeDescription(scope);
  if (
    !shaPattern.test(writeSha) ||
    !isJsonRecord(pull) ||
    pull.number !== scope.prNumber ||
    pull.state !== "closed" ||
    pull.merged !== true ||
    (!isManagedTransferDirection(pull, scope.repository) &&
      !isStagedTransferDirection(pull, scope.repository)) ||
    getJsonString(pull.base, "ref") !== scope.targetBranch ||
    getJsonString(pull.head, "sha") !== scope.headSha ||
    getJsonString(pull, "merge_commit_sha") !== writeSha ||
    !Number.isFinite(Date.parse(getJsonString(pull, "merged_at"))) ||
    !isJsonRecord(commit) ||
    getJsonString(commit, "sha") !== writeSha ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    getJsonString(commit.parents[0], "sha") !== scope.baseSha ||
    !isJsonRecord(snapshot) ||
    getJsonString(snapshot, "sha") !== scope.mergeSha ||
    !Array.isArray(snapshot.parents) ||
    snapshot.parents.length !== 2 ||
    getJsonString(snapshot.parents[0], "sha") !== scope.baseSha ||
    getJsonString(snapshot.parents[1], "sha") !== scope.headSha ||
    !shaPattern.test(getJsonString(snapshot.tree, "sha")) ||
    getJsonString(commit.tree, "sha") !== getJsonString(snapshot.tree, "sha")
  ) {
    throw new CliError("Transfer write does not match the authorized squash snapshot.", 65);
  }
}

export async function verifyRecordedTransferWrite(
  reader: JsonReader,
  repository: string,
  targetBranch: ManagedBranch,
  writeSha: string,
  prNumber: number,
  headSha: string,
  controlRepository: string,
  now = Date.now()
): Promise<PrCiScope> {
  const prefix = `repos/${repository}`;
  const pull = await reader.get(`${prefix}/pulls/${prNumber}`);
  const mergedAt = Date.parse(getJsonString(pull, "merged_at"));
  const statuses = await reader.get(`${prefix}/commits/${writeSha}/status`);
  const context = transferReceiptContext(targetBranch);
  const receipt = latestAttestedStatus(statuses, { repository, sha: writeSha, context });
  const match = /^transfer-v1=([0-9a-f]{40})$/.exec(originalStatusDescription(receipt));
  const runUrl = getJsonString(receipt, "target_url");
  const runId = trustedControlRunId(runUrl, controlRepository);
  if (receipt?.state !== "success" || !match?.[1] || !runId || statusRunAttempt(receipt) !== 1) {
    if (Number.isFinite(mergedAt) && mergedAt <= now && now - mergedAt < 300_000) {
      throw new TransferWritePendingError("Transfer merge receipt is not yet available.", 75);
    }
    throw new CliError("Managed transfer lacks a signed merge receipt.", 65);
  }
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
  if (
    !isJsonRecord(run) ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    getJsonNumber(run, "id") !== runId ||
    getJsonNumber(run, "run_attempt") !== 1 ||
    getJsonString(run, "path") !== transferWorkflowPath ||
    getJsonString(run, "head_branch") !== "main" ||
    getJsonString(run, "event") !== "workflow_dispatch" ||
    getJsonString(run.actor, "type") !== "User" ||
    getJsonNumber(run.actor, "id") < 1 ||
    getJsonNumber(run.actor, "id") !== getJsonNumber(run.triggering_actor, "id")
  ) {
    throw new CliError("Transfer receipt does not identify a fresh manual administrator run.", 65);
  }
  if (["queued", "in_progress", "waiting", "pending"].includes(getJsonString(run, "status"))) {
    throw new TransferWritePendingError("Transfer publisher is still running.", 75);
  }
  const commit = await reader.get(`${prefix}/git/commits/${writeSha}`);
  const parent =
    isJsonRecord(commit) && Array.isArray(commit.parents) && commit.parents.length === 1
      ? getJsonString(commit.parents[0], "sha")
      : "";
  const scope: PrCiScope = {
    repository,
    prNumber,
    targetBranch,
    baseSha: parent,
    headSha,
    mergeSha: match[1],
  };
  const snapshot = await reader.get(`${prefix}/git/commits/${scope.mergeSha}`);
  verifyTransferCommit(scope, writeSha, pull, commit, snapshot);
  if (isStagedTransferDirection(pull, repository)) {
    if (!isJsonRecord(pull)) throw new CliError("Invalid staged transfer PR.", 65);
    const preparation = await verifyStagedTransferProof(
      reader,
      scope,
      getJsonString(pull.head, "ref"),
      runId,
      runUrl
    );
    if (
      preparation.createdAt > mergedAt ||
      !(await hasVerifiedControlStatus(reader, preparation.statuses, "Transfer Preparation", {
          controlRepository,
          targetRepository: repository,
          targetSha: headSha,
          workflowPaths: [transferWorkflowPath],
          runAttempts: 1,
        }))
    ) {
      throw new CliError("Staged transfer preparation is not independently verified.", 65);
    }
  }
  const receiptAt = Date.parse(getJsonString(receipt, "created_at"));
  const gateContext = transferGateContext(targetBranch);
  const gateStatuses = await reader.get(`${prefix}/commits/${scope.mergeSha}/status`);
  const gate = latestAttestedStatus(gateStatuses, {
    repository,
    sha: scope.mergeSha,
    context: gateContext,
  });
  const gateAt = Date.parse(getJsonString(gate, "created_at"));
  if (
    !Number.isFinite(receiptAt) ||
    receiptAt < mergedAt ||
    gate?.state !== "success" ||
    statusRunAttempt(gate) !== 1 ||
    originalStatusDescription(gate) !== prCiScopeDescription(scope) ||
    getJsonString(gate, "target_url") !== runUrl ||
    !Number.isFinite(gateAt) ||
    gateAt > mergedAt
  ) {
    throw new CliError("Transfer write lacks the exact pre-merge CI gate.", 65);
  }
  for (const [response, statusContext, sha] of [
    [statuses, context, writeSha],
    [gateStatuses, gateContext, scope.mergeSha],
  ] as const) {
    if (
      !(await hasVerifiedControlStatus(reader, response, statusContext, {
        controlRepository,
        targetRepository: repository,
        targetSha: sha,
        workflowPaths: [transferWorkflowPath],
        runAttempts: 1,
      }))
    ) {
      throw new CliError("Transfer gate or receipt publisher is not verified.", 65);
    }
  }
  return scope;
}
