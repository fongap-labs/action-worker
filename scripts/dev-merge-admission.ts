import {
  defaultControlRepository,
  hasVerifiedCiEvidence,
  hasVerifiedControlStatus,
  type JsonReader,
  prGateWorkflowPaths,
  trustedControlRunId,
} from "./ci-evidence.ts";
import {
  devGovernanceReceipt,
  type PrCiScope,
  prCiScopeDescription,
  readCurrentPrCiScope,
} from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import { getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { assertNoOpenManagedWriteIncidents } from "./main-write-incidents.ts";
import { resolveManagedBranchMerge } from "./managed-branch-provenance.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { isGovernedPullDirection } from "./resolve-pr-facts.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { latestAttestedStatus, originalStatusDescription } from "./status-attestation.ts";

const devGates = ["Dev PR Governance", "validate-merge-dev"] as const;
const shaPattern = /^[0-9a-f]{40}$/;

function titleFingerprint(pull: unknown): string {
  const title = getJsonString(pull, "title").replace(/[\r\n]/g, " ");
  if (!title) throw new CliError("Dev PR title missing.", 75);
  return prTitleFingerprint(title);
}

function assertDevPull(pull: unknown, scope: PrCiScope, merged: boolean): void {
  if (
    !isJsonRecord(pull) ||
    pull.number !== scope.prNumber ||
    pull.state !== (merged ? "closed" : "open") ||
    pull.merged !== merged ||
    !isGovernedPullDirection(pull, "dev") ||
    !isJsonRecord(pull.head) ||
    !isJsonRecord(pull.base) ||
    !isJsonRecord(pull.base.repo) ||
    pull.base.repo.private !== false ||
    getJsonString(pull.base.repo, "full_name") !== scope.repository ||
    getJsonString(pull.head.repo, "full_name") !== scope.repository ||
    getJsonString(pull.head, "sha") !== scope.headSha ||
    (!merged &&
      (pull.draft !== false ||
        pull.mergeable !== true ||
        pull.mergeable_state === "behind" ||
        getJsonString(pull.base, "sha") !== scope.baseSha))
  ) {
    throw new CliError("Dev merge identity or direction is not eligible.", 75);
  }
}

function assertDevGates(
  response: unknown,
  scope: PrCiScope,
  fingerprint: string,
  runUrl: string,
  mergedAt = Number.POSITIVE_INFINITY
): void {
  const expected = devGovernanceReceipt(scope, fingerprint);
  for (const context of devGates) {
    const status = latestAttestedStatus(response, {
      repository: scope.repository,
      sha: scope.headSha,
      context,
    });
    const created = Date.parse(getJsonString(status, "created_at"));
    if (
      status?.state !== "success" ||
      originalStatusDescription(status) !== expected ||
      getJsonString(status, "target_url") !== runUrl ||
      !Number.isFinite(created) ||
      created > mergedAt
    ) {
      throw new CliError("Dev merge lacks current signed governance scope.", 75);
    }
  }
}

async function requireDevCi(
  reader: JsonReader,
  response: unknown,
  scope: PrCiScope,
  controlRepository: string
): Promise<void> {
  if (
    !(await hasVerifiedCiEvidence(reader, response, {
      controlRepository,
      targetRepository: scope.repository,
      targetSha: scope.headSha,
      expectedPrScope: scope,
      runAttempts: 1,
    }))
  ) {
    throw new CliError("Dev merge lacks verified CI snapshot.", 75);
  }
}

/** Read-only admission; the caller may not use this to bypass branch protection. */
export async function verifyDevMergeAdmission(
  reader: JsonReader,
  repository: string,
  prNumber: number,
  headSha: string,
  baseSha: string,
  runUrl: string,
  controlRepository = defaultControlRepository
): Promise<PrCiScope> {
  if (trustedControlRunId(runUrl, controlRepository) === null) {
    throw new CliError("Invalid dev governance run identity.", 65);
  }
  const scope = await readCurrentPrCiScope(reader, repository, prNumber, headSha, "dev");
  if (!scope || scope.baseSha !== baseSha) {
    throw new CliError("Dev merge snapshot changed.", 75);
  }
  const path = `repos/${repository}/pulls/${prNumber}`;
  const pull = await reader.get(path);
  assertDevPull(pull, scope, false);
  const title = titleFingerprint(pull);
  const statuses = await reader.get(`repos/${repository}/commits/${headSha}/status`);
  assertDevGates(statuses, scope, title, runUrl);
  await requireDevCi(reader, statuses, scope, controlRepository);
  const current = await readCurrentPrCiScope(reader, repository, prNumber, headSha, "dev");
  if (!current || prCiScopeDescription(current) !== prCiScopeDescription(scope)) {
    throw new CliError("Dev merge snapshot changed.", 75);
  }
  const latest = await reader.get(path);
  assertDevPull(latest, scope, false);
  if (titleFingerprint(latest) !== title) {
    throw new CliError("Dev merge title changed.", 75);
  }
  return scope;
}

/** Verify a completed squash write against the exact snapshot validated before merge. */
export async function verifyDevSquashWrite(
  reader: JsonReader,
  scope: PrCiScope,
  writeSha: string,
  fingerprint: string,
  runUrl: string,
  controlRepository = defaultControlRepository
): Promise<void> {
  devGovernanceReceipt(scope, fingerprint);
  if (!shaPattern.test(writeSha) || trustedControlRunId(runUrl, controlRepository) === null) {
    throw new CliError("Invalid dev write identity.", 65);
  }
  const prefix = `repos/${scope.repository}`;
  const commit = await reader.get(`${prefix}/git/commits/${writeSha}`);
  const snapshot = await reader.get(`${prefix}/git/commits/${scope.mergeSha}`);
  if (
    !isJsonRecord(commit) ||
    !isJsonRecord(snapshot) ||
    getJsonString(commit, "sha") !== writeSha ||
    getJsonString(snapshot, "sha") !== scope.mergeSha ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    getJsonString(commit.parents[0], "sha") !== scope.baseSha ||
    !Array.isArray(snapshot.parents) ||
    snapshot.parents.length !== 2 ||
    getJsonString(snapshot.parents[0], "sha") !== scope.baseSha ||
    getJsonString(snapshot.parents[1], "sha") !== scope.headSha ||
    !shaPattern.test(getJsonString(snapshot.tree, "sha")) ||
    getJsonString(commit.tree, "sha") !== getJsonString(snapshot.tree, "sha")
  ) {
    throw new CliError("Dev squash parent or source tree differs from CI snapshot.", 75);
  }
  // The full commit endpoint carries the commit-message fallback used by attribution.
  const fullCommit = await reader.get(`${prefix}/commits/${writeSha}`);
  const origin = await resolveManagedBranchMerge(
    reader,
    scope.repository,
    "dev",
    writeSha,
    fullCommit
  );
  const pull = await reader.get(`${prefix}/pulls/${scope.prNumber}`);
  assertDevPull(pull, scope, true);
  const mergedAt = Date.parse(getJsonString(pull, "merged_at"));
  if (
    origin.pr_number !== scope.prNumber ||
    origin.pr_head_sha !== scope.headSha ||
    getJsonString(pull, "merge_commit_sha") !== writeSha ||
    !Number.isFinite(mergedAt)
  ) {
    throw new CliError("Dev write does not match the admitted PR.", 75);
  }
  const statuses = await reader.get(`${prefix}/commits/${scope.headSha}/status`);
  assertDevGates(statuses, scope, fingerprint, runUrl, mergedAt);
  const ci = latestAttestedStatus(statuses, {
    repository: scope.repository,
    sha: scope.headSha,
    context: "Dev CI Evidence",
  });
  const ciCreated = Date.parse(getJsonString(ci, "created_at"));
  if (!Number.isFinite(ciCreated) || ciCreated > mergedAt) {
    throw new CliError("Dev write CI must precede merge.", 75);
  }
  await requireDevCi(reader, statuses, scope, controlRepository);
  for (const context of devGates) {
    if (
      !(await hasVerifiedControlStatus(reader, statuses, context, {
        controlRepository,
        targetRepository: scope.repository,
        targetSha: scope.headSha,
        workflowPaths: prGateWorkflowPaths,
        runAttempts: 1,
      }))
    ) {
      throw new CliError("Dev write requires completed successful governance.", 75);
    }
  }
  await assertNoOpenManagedWriteIncidents(reader, scope.repository, "dev");
}

async function main(): Promise<void> {
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    requireToken("control"),
    requireToken("status")
  );
  const repository = process.env.REPOSITORY ?? "";
  const prNumber = Number(process.env.PR_NUMBER ?? "");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1
  ) {
    throw new CliError("Invalid dev PR identity.", 65);
  }
  const pull = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  if (isJsonRecord(pull) && pull.draft === true) {
    console.log("Dev PR is a draft; merge admission skipped.");
    return;
  }
  await verifyDevMergeAdmission(
    reader,
    repository,
    prNumber,
    process.env.HEAD_SHA ?? "",
    process.env.BASE_SHA ?? "",
    process.env.RUN_URL ?? "",
    process.env.GITHUB_REPOSITORY ?? defaultControlRepository
  );
  console.log("Dev merge admission passed; no write attempted.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
