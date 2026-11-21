import { createHash } from "node:crypto";
import {
  defaultControlRepository,
  hasVerifiedCiEvidence,
  hasVerifiedControlStatus,
  prGateWorkflowPaths,
  trustedControlRunId,
  type JsonReader,
} from "./ci-evidence.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { loadGateContract, requiredGateContexts } from "./governance-gate-contract.ts";
import { CliError } from "./runtime-command.ts";
import { assertReadyForAutomaticMerge } from "./auto-merge-pr.ts";
import { latestAttestedStatus } from "./status-attestation.ts";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface RepairPullRequestIdentity {
  readonly repository: string;
  readonly issue_number: number;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_sha: string;
}

export interface VerifiedRepairCiEvidence extends RepairPullRequestIdentity {
  readonly schema_version: "1";
  readonly ci_run_id: number;
  readonly governance_run_id: number;
  readonly ci_status_id: number;
  readonly governance_status_id: number;
  readonly merge_status_id: number;
  readonly required_gate_contexts: readonly string[];
  readonly evidence_sha256: string;
  readonly verified_at: string;
}

export interface RepairCiVerificationOptions {
  readonly control_repository?: string;
  readonly verified_at: string;
}

function validateIdentity(identity: RepairPullRequestIdentity): void {
  if (
    !REPOSITORY.test(identity.repository) ||
    identity.repository !== identity.repository.toLowerCase() ||
    !Number.isSafeInteger(identity.issue_number) ||
    identity.issue_number <= 0 ||
    !Number.isSafeInteger(identity.pr_number) ||
    identity.pr_number <= 0 ||
    !GIT_SHA.test(identity.head_sha) ||
    !GIT_SHA.test(identity.base_sha)
  ) {
    throw new CliError("Repair CI verification identity is invalid.", 64);
  }
}

function validateTime(value: string): void {
  if (!UTC_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CliError("Repair CI verification timestamp is invalid.", 64);
  }
}

function requireTrustedRunId(targetUrl: string, controlRepository: string, label: string): number {
  const runId = trustedControlRunId(targetUrl, controlRepository);
  if (runId === null) throw new CliError("Repair CI " + label + " run is not a trusted control run.", 65);
  return runId;
}

function requireSameRepositoryPull(pull: unknown, repository: string): void {
  if (!isJsonRecord(pull)) throw new CliError("Repair CI pull request response is invalid.", 65);
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const headRepo = isJsonRecord(head.repo) ? head.repo : {};
  const baseRepo = isJsonRecord(base.repo) ? base.repo : {};
  if (
    getJsonString(headRepo, "full_name").toLowerCase() !== repository ||
    getJsonString(baseRepo, "full_name").toLowerCase() !== repository
  ) {
    throw new CliError("Repair CI verification refuses fork or cross-repository pull requests.", 75);
  }
}

/** Read-only gate verification. It never updates a ledger, labels a PR, or merges it. */
export async function verifyRepairPullRequest(
  reader: JsonReader,
  identity: RepairPullRequestIdentity,
  options: RepairCiVerificationOptions
): Promise<VerifiedRepairCiEvidence> {
  validateIdentity(identity);
  validateTime(options.verified_at);
  const controlRepository = options.control_repository ?? defaultControlRepository;
  if (!REPOSITORY.test(controlRepository)) {
    throw new CliError("Repair CI control repository is invalid.", 64);
  }

  const pull = await reader.get(
    "repos/" + identity.repository + "/pulls/" + identity.pr_number
  );
  requireSameRepositoryPull(pull, identity.repository);
  const statuses = await reader.get(
    "repos/" + identity.repository + "/commits/" + identity.head_sha + "/status"
  );
  const contract = loadGateContract();
  const governanceStatus = latestAttestedStatus(statuses, {
    repository: identity.repository,
    sha: identity.head_sha,
    context: contract.status_contexts.pr_governance,
  });
  const governanceRunUrl = getJsonString(governanceStatus, "target_url");
  const governanceRunId = requireTrustedRunId(governanceRunUrl, controlRepository, "governance");

  assertReadyForAutomaticMerge(
    pull,
    statuses,
    identity.repository,
    identity.pr_number,
    identity.head_sha,
    identity.base_sha,
    governanceRunUrl
  );

  const ciVerified = await hasVerifiedCiEvidence(reader, statuses, {
    controlRepository,
    targetRepository: identity.repository,
    targetSha: identity.head_sha,
  });
  if (!ciVerified) {
    throw new CliError("Repair CI requires a completed successful central CI run for the exact PR head.", 75);
  }
  const governanceVerified = await hasVerifiedControlStatus(
    reader,
    statuses,
    contract.status_contexts.pr_governance,
    {
      controlRepository,
      targetRepository: identity.repository,
      targetSha: identity.head_sha,
      workflowPaths: prGateWorkflowPaths,
    }
  );
  if (!governanceVerified) {
    throw new CliError("Repair CI requires a trusted completed PR Governance run for the exact PR head.", 75);
  }

  const ciStatus = latestAttestedStatus(statuses, {
    repository: identity.repository,
    sha: identity.head_sha,
    context: contract.status_contexts.ci_evidence,
  });
  const mergeStatus = latestAttestedStatus(statuses, {
    repository: identity.repository,
    sha: identity.head_sha,
    context: contract.status_contexts.merge_validation,
  });
  const ciRunId = requireTrustedRunId(
    getJsonString(ciStatus, "target_url"),
    controlRepository,
    "CI Evidence"
  );
  if (
    !mergeStatus ||
    getJsonString(mergeStatus, "target_url") !== governanceRunUrl ||
    getJsonString(mergeStatus, "state") !== "success"
  ) {
    throw new CliError("Repair CI requires signed Merge Validation from the same governance run.", 75);
  }
  const ciStatusId = getJsonNumber(ciStatus, "id");
  const governanceStatusId = getJsonNumber(governanceStatus, "id");
  const mergeStatusId = getJsonNumber(mergeStatus, "id");
  if ([ciStatusId, governanceStatusId, mergeStatusId].some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new CliError("Repair CI status evidence identifiers are invalid.", 65);
  }

  const proof = {
    schema_version: "1" as const,
    repository: identity.repository,
    issue_number: identity.issue_number,
    pr_number: identity.pr_number,
    head_sha: identity.head_sha,
    base_sha: identity.base_sha,
    ci_run_id: ciRunId,
    governance_run_id: governanceRunId,
    ci_status_id: ciStatusId,
    governance_status_id: governanceStatusId,
    merge_status_id: mergeStatusId,
    required_gate_contexts: requiredGateContexts(contract),
    verified_at: options.verified_at,
  };
  const evidenceSha256 = createHash("sha256")
    .update(JSON.stringify(proof), "utf8")
    .digest("hex");
  return { ...proof, evidence_sha256: evidenceSha256 };
}
