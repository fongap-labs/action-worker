import { createHash } from "node:crypto";
import {
  hasVerifiedCiEvidence,
  hasVerifiedControlStatus,
  type JsonReader,
  latestCiStatus,
  mainWriteGuardWorkflowPaths,
  postMergeRemediationStatusPrefix,
} from "./ci-evidence.ts";
import { getJsonArray, getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { loadGateContract } from "./governance-gate-contract.ts";
import { verifiedRepairCiDigest } from "./repair-ledger-ci.ts";
import type { RepairLedgerDocument } from "./repair-ledger-store.ts";
import { CliError } from "./runtime-command.ts";
import { originalStatusDescription } from "./status-attestation.ts";

const SHA = /^[a-f0-9]{40}$/;
const contract = loadGateContract();

function checkMainRunId(url: string, controlRepository: string): number | null {
  const prefix = ["https://github.com", controlRepository, "actions/runs"].join("/");
  if (!url.startsWith(prefix + "/")) return null;
  const suffix = url.slice(prefix.length + 1);
  const match = /^([1-9][0-9]*)\/job\/[1-9][0-9]*$/.exec(suffix);
  if (!match) return null;
  const runId = Number(match[1]);
  return Number.isSafeInteger(runId) ? runId : null;
}

async function hasVerifiedLocalMainCi(
  reader: JsonReader,
  repository: string,
  controlRepository: string,
  mainSha: string
): Promise<number | null> {
  if (repository !== controlRepository) return null;
  const response = await reader.get(
    ["repos", repository, "commits", mainSha, "check-runs?filter=latest&per_page=100"].join("/")
  );
  const checkRuns = getJsonArray(response, "check_runs");
  for (const check of checkRuns) {
    if (
      !isJsonRecord(check) ||
      getJsonString(check, "name") !== "Main CI" ||
      getJsonString(check, "head_sha") !== mainSha ||
      getJsonString(check, "status") !== "completed" ||
      getJsonString(check, "conclusion") !== "success" ||
      getJsonString(check.app, "slug") !== "github-actions"
    ) {
      continue;
    }
    const runId = checkMainRunId(getJsonString(check, "details_url"), controlRepository);
    if (runId === null) continue;
    const run = await reader.get(["repos", controlRepository, "actions/runs", String(runId)].join("/"));
    if (
      !isJsonRecord(run) ||
      getJsonNumber(run, "id") !== runId ||
      getJsonString(run.repository, "full_name") !== controlRepository ||
      getJsonString(run, "path") !== ".github/workflows/intake.yml" ||
      getJsonString(run, "head_branch") !== "main" ||
      getJsonString(run, "head_sha") !== mainSha ||
      getJsonString(run, "status") !== "completed" ||
      getJsonString(run, "conclusion") !== "success" ||
      getJsonString(run, "event") !== "push"
    ) {
      continue;
    }
    const id = getJsonNumber(check, "id");
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}

/**
 * A repair is finished only after the exact merged commit is the current
 * default-branch HEAD and that commit has actually passed main CI and a
 * signed Main Write Guard. PR-level green checks are insufficient.
 */
export async function verifiedRepairPostMergeDigest(
  reader: JsonReader,
  document: RepairLedgerDocument,
  controlRepository: string
): Promise<string> {
  const { repository, entry } = document;
  if (
    entry.stage !== "ci_verifying" ||
    entry.pr_number === null ||
    entry.head_sha === null ||
    entry.ci_head_sha !== entry.head_sha ||
    entry.ci_run_id === null
  ) {
    throw new CliError("Repair has no eligible current-head PR CI record.", 75);
  }
  const prPath = ["repos", repository, "pulls", String(entry.pr_number)].join("/");
  const getMerged = async () => {
    const pr = await reader.get(prPath);
    const mergeSha = getJsonString(pr, "merge_commit_sha");
    if (
      !isJsonRecord(pr) ||
      pr.number !== entry.pr_number ||
      pr.state !== "closed" ||
      pr.merged !== true ||
      !getJsonString(pr, "merged_at") ||
      getJsonString(pr.head, "sha") !== entry.head_sha ||
      getJsonString(pr.base, "ref") !== "main" ||
      !SHA.test(mergeSha)
    ) {
      throw new CliError("Repair PR must be merged from the recorded HEAD into main.", 75);
    }
    return mergeSha;
  };

  const mergeSha = await getMerged();
  const prEvidence = await verifiedRepairCiDigest(reader, document, controlRepository, true);
  const repositoryInfo = await reader.get(["repos", repository].join("/"));
  if (
    getJsonString(repositoryInfo, "full_name").toLowerCase() !== repository.toLowerCase() ||
    getJsonString(repositoryInfo, "default_branch") !== "main"
  ) {
    throw new CliError("Repair target main branch is untrusted or has changed.", 75);
  }
  const branchPath = ["repos", repository, "branches/main"].join("/");
  const readBranchHead = async () => {
    const branch = await reader.get(branchPath);
    const sha = isJsonRecord(branch) ? getJsonString(branch.commit, "sha") : "";
    if (!SHA.test(sha)) throw new CliError("Repair target main HEAD is invalid.", 75);
    return sha;
  };
  const mainSha = await readBranchHead();
  if (mainSha !== mergeSha) {
    throw new CliError("Repair merge commit is no longer the current main HEAD.", 75);
  }

  const mainStatuses = await reader.get(
    ["repos", repository, "commits", mainSha, "status"].join("/")
  );
  const ciStatus = latestCiStatus(mainStatuses, contract.status_contexts.ci_evidence);
  let mainCiProof: string | null = null;
  if (ciStatus) {
    const valid = await hasVerifiedCiEvidence(reader, mainStatuses, {
      controlRepository,
      targetRepository: repository,
      targetSha: mainSha,
      runAttempts: 1,
      retryDelayMs: 0,
    });
    if (!valid) throw new CliError("Repair main CI Evidence is not verified successful.", 75);
    const ciId = getJsonNumber(ciStatus, "id");
    if (!Number.isSafeInteger(ciId) || ciId <= 0) {
      throw new CliError("Repair main CI status identifier is invalid.", 65);
    }
    mainCiProof = ["status", String(ciId)].join(":");
  } else {
    const id = await hasVerifiedLocalMainCi(reader, repository, controlRepository, mainSha);
    if (id === null) throw new CliError("Repair main CI is missing or not verified successful.", 75);
    mainCiProof = ["check", String(id)].join(":");
  }
  const guard = latestCiStatus(mainStatuses, "Main Write Guard");
  if (
    !guard ||
    originalStatusDescription(guard).startsWith(postMergeRemediationStatusPrefix) ||
    !(await hasVerifiedControlStatus(reader, mainStatuses, "Main Write Guard", {
      controlRepository,
      targetRepository: repository,
      targetSha: mainSha,
      workflowPaths: mainWriteGuardWorkflowPaths,
      runAttempts: 1,
      retryDelayMs: 0,
    }))
  ) {
    throw new CliError("Repair main write guard is missing or untrusted.", 75);
  }
  const guardId = getJsonNumber(guard, "id");
  if (!Number.isSafeInteger(guardId) || guardId <= 0) {
    throw new CliError("Repair main write guard status ID is invalid.", 65);
  }
  if ((await getMerged()) !== mergeSha || (await readBranchHead()) !== mainSha) {
    throw new CliError("Repair main or PR changed during verification.", 75);
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        "action-worker-repair-post-merge-ci-v1",
        repository,
        entry.pr_number,
        entry.head_sha,
        mergeSha,
        prEvidence,
        mainCiProof,
        guardId,
      ])
    )
    .digest("hex");
}
