import {
  hasVerifiedControlStatus,
  type JsonReader,
  prGateWorkflowPaths,
  trustedControlRunId,
} from "./ci-evidence.ts";
import { type PrCiScope, prCiScopeDescription } from "./ci-scope-receipt.ts";
import { verifyDevSquashWrite } from "./dev-merge-admission.ts";
import { getJsonString, isJsonRecord } from "./github-api.ts";
import { assertNoOpenManagedWriteIncidents } from "./main-write-incidents.ts";
import {
  managedBranchWriteContext,
  resolveManagedBranchMerge,
} from "./managed-branch-provenance.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { CliError } from "./runtime-command.ts";
import { latestAttestedStatus, originalStatusDescription } from "./status-attestation.ts";

export const devMergeReceiptContext = "Dev Merge Receipt";
export class DevWritePendingError extends CliError {}
const context = managedBranchWriteContext("dev");
const shaPattern = /^[0-9a-f]{40}$/;
const auditWorkflows = [".github/workflows/intake.yml"];

export async function hasVerifiedDevWriteGuard(
  reader: JsonReader,
  repository: string,
  sha: string,
  statuses: unknown,
  controlRepository: string
): Promise<boolean> {
  const status = latestAttestedStatus(statuses, { repository, sha, context });
  if (!/^scope-v1=[A-Za-z0-9_-]{43}$/.test(originalStatusDescription(status))) return false;
  return hasVerifiedControlStatus(reader, statuses, context, {
    controlRepository,
    targetRepository: repository,
    targetSha: sha,
    workflowPaths: auditWorkflows,
    runAttempts: 1,
  });
}

export async function assertTrustedDevWrite(
  reader: JsonReader,
  repository: string,
  sha: string,
  controlRepository: string
): Promise<void> {
  await assertNoOpenManagedWriteIncidents(reader, repository, "dev");
  const statuses = await reader.get(`repos/${repository}/commits/${sha}/status`);
  if (!(await hasVerifiedDevWriteGuard(reader, repository, sha, statuses, controlRepository))) {
    throw new CliError("Development base lacks trusted Dev Write Guard.", 75);
  }
}

/** Reconstruct the exact merge proof from a signed receipt, never from a moving branch ref. */
export async function verifyRecordedDevWrite(
  reader: JsonReader,
  repository: string,
  sha: string,
  controlRepository: string,
  now = Date.now()
): Promise<{ scope: PrCiScope; description: string }> {
  const prefix = `repos/${repository}`;
  const commit = await reader.get(`${prefix}/commits/${sha}`);
  const origin = await resolveManagedBranchMerge(reader, repository, "dev", sha, commit);
  const pull = await reader.get(`${prefix}/pulls/${origin.pr_number}`);
  const statuses = await reader.get(`${prefix}/commits/${sha}/status`);
  const receipt = latestAttestedStatus(statuses, {
    repository,
    sha,
    context: devMergeReceiptContext,
  });
  const match = /^merge-v1=([0-9a-f]{40})$/.exec(originalStatusDescription(receipt));
  const runUrl = getJsonString(receipt, "target_url");
  const runId = trustedControlRunId(runUrl, controlRepository);
  if (receipt?.state !== "success" || !match?.[1] || !runId) {
    const mergedAt = Date.parse(getJsonString(pull, "merged_at"));
    if (Number.isFinite(mergedAt) && mergedAt <= now && now - mergedAt < 300_000) {
      throw new DevWritePendingError("Development merge receipt is not yet available.", 75);
    }
    throw new CliError("Development write lacks a signed merge receipt.", 65);
  }
  const mergedAt = Date.parse(getJsonString(pull, "merged_at"));
  const receiptAt = Date.parse(getJsonString(receipt, "created_at"));
  if (!Number.isFinite(mergedAt) || !Number.isFinite(receiptAt) || receiptAt < mergedAt) {
    throw new CliError("Development merge receipt must follow the actual write.", 65);
  }
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
  if (
    isJsonRecord(run) &&
    getJsonString(run.repository, "full_name") === controlRepository &&
    run.id === runId &&
    prGateWorkflowPaths.includes(getJsonString(run, "path")) &&
    run.head_branch === "main" &&
    ["queued", "in_progress", "waiting", "pending"].includes(getJsonString(run, "status"))
  ) {
    throw new DevWritePendingError("Development merge publisher has not finished.", 75);
  }
  if (
    !(await hasVerifiedControlStatus(reader, statuses, devMergeReceiptContext, {
      controlRepository,
      targetRepository: repository,
      targetSha: sha,
      workflowPaths: prGateWorkflowPaths,
      runAttempts: 1,
    }))
  ) {
    throw new CliError("Development merge receipt publisher is not verified.", 65);
  }
  const gitCommit = await reader.get(`${prefix}/git/commits/${sha}`);
  const parent =
    isJsonRecord(gitCommit) && Array.isArray(gitCommit.parents) && gitCommit.parents.length === 1
      ? getJsonString(gitCommit.parents[0], "sha")
      : "";
  if (!shaPattern.test(parent)) throw new CliError("Invalid development squash parent.", 65);
  const scope: PrCiScope = {
    repository,
    prNumber: origin.pr_number,
    targetBranch: "dev",
    baseSha: parent,
    headSha: origin.pr_head_sha,
    mergeSha: match[1],
  };
  const title = getJsonString(pull, "title").replace(/[\r\n]/g, " ");
  if (!title) throw new CliError("Development PR title missing.", 65);
  await assertTrustedDevWrite(reader, repository, parent, controlRepository);
  await verifyDevSquashWrite(
    reader,
    scope,
    sha,
    prTitleFingerprint(title),
    runUrl,
    controlRepository
  );
  return { scope, description: prCiScopeDescription(scope) };
}
