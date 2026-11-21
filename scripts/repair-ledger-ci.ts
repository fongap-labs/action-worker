import { createHash } from "node:crypto";
import {
  hasVerifiedCiEvidence,
  hasVerifiedControlStatus,
  type JsonReader,
  latestCiStatus,
  prGateWorkflowPaths,
  trustedControlRunId,
} from "./ci-evidence.ts";
import { getJsonString, isJsonRecord } from "./github-api.ts";
import { loadGateContract } from "./governance-gate-contract.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import type { RepairLedgerDocument } from "./repair-ledger-store.ts";
import { CliError } from "./runtime-command.ts";
import { originalStatusDescription } from "./status-attestation.ts";

const SHA = /^[a-f0-9]{40}$/;
const contract = loadGateContract();

/** Verify current-head CI and governance proof without accepting caller-provided success flags. */
export async function verifiedRepairCiDigest(
  reader: JsonReader,
  document: RepairLedgerDocument,
  controlRepository: string
): Promise<string> {
  const { entry, repository } = document;
  if (
    entry.stage !== "ci_verifying" ||
    !entry.head_sha ||
    !SHA.test(entry.head_sha) ||
    !entry.ci_run_id ||
    entry.ci_head_sha !== entry.head_sha ||
    !entry.pr_number
  ) {
    throw new CliError("Repair task lacks current-head CI evidence.", 65);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) {
    throw new CliError("Repair CI control repository is invalid.", 65);
  }
  const headSha = entry.head_sha;
  const prPath = ["repos", repository, "pulls", String(entry.pr_number)].join("/");
  const readPull = async () => {
    const value = await reader.get(prPath);
    if (
      !isJsonRecord(value) ||
      value.number !== entry.pr_number ||
      value.state !== "open" ||
      value.merged === true ||
      getJsonString(value.head, "sha") !== headSha ||
      getJsonString(value.base, "ref") !== "main" ||
      !SHA.test(getJsonString(value.base, "sha"))
    ) {
      throw new CliError("Repair PR is not the current open main-targeting HEAD.", 75);
    }
    const title = getJsonString(value, "title");
    if (!title) throw new CliError("Repair PR title is not available.", 65);
    return { baseSha: getJsonString(value.base, "sha"), title };
  };
  const observed = await readPull();
  const response = await reader.get(["repos", repository, "commits", headSha, "status"].join("/"));
  const ciStatus = latestCiStatus(response, contract.status_contexts.ci_evidence);
  const ciRunId = trustedControlRunId(getJsonString(ciStatus, "target_url"), controlRepository);
  if (ciRunId !== entry.ci_run_id) {
    throw new CliError("Repair CI run does not match the pending task run.", 75);
  }
  const shared = {
    controlRepository,
    targetRepository: repository,
    targetSha: headSha,
    runAttempts: 1,
    retryDelayMs: 0,
  };
  if (!(await hasVerifiedCiEvidence(reader, response, shared))) {
    throw new CliError("Repair CI Evidence is missing, skipped, untrusted or failed.", 75);
  }
  let governanceUrl: string | null = null;
  const gateIds: Array<{ context: string; id: number }> = [];
  for (const role of ["pr_governance", "merge_validation"] as const) {
    const context = contract.status_contexts[role];
    const status = latestCiStatus(response, context);
    if (
      !isJsonRecord(status) ||
      getJsonString(status, "state") !== "success" ||
      !originalStatusDescription(status).startsWith(
        ["title-sha256=", prTitleFingerprint(observed.title), " "].join("")
      ) ||
      !(await hasVerifiedControlStatus(reader, response, context, {
        ...shared,
        workflowPaths: prGateWorkflowPaths,
      }))
    ) {
      throw new CliError("Repair governance gate is missing, untrusted or failed.", 75);
    }
    const statusUrl = getJsonString(status, "target_url");
    if (governanceUrl !== null && governanceUrl !== statusUrl) {
      throw new CliError("Repair governance gates belong to different runs.", 75);
    }
    governanceUrl = statusUrl;
    const id = status.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new CliError("Repair governance status ID is invalid.", 65);
    }
    gateIds.push({ context, id });
  }
  const fresh = await readPull();
  if (fresh.baseSha !== observed.baseSha || fresh.title !== observed.title) {
    throw new CliError("Repair PR changed during CI verification.", 75);
  }
  const ciId = isJsonRecord(ciStatus) ? ciStatus.id : undefined;
  if (typeof ciId !== "number" || !Number.isSafeInteger(ciId) || ciId <= 0) {
    throw new CliError("Repair CI status ID is invalid.", 65);
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        "action-worker-verified-repair-ci-v1",
        repository,
        entry.pr_number,
        headSha,
        observed.baseSha,
        ciRunId,
        ciId,
        gateIds,
      ])
    )
    .digest("hex");
}
