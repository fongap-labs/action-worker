import { readFileSync } from "node:fs";
import { resolveTransferPrNumber } from "./authorize-branch-operation.ts";
import { assertManualBranchAuthorization } from "./branch-transfer-approval.ts";
import {
  transferGateContext,
  transferReceiptContext,
  verifyTransferCommit,
} from "./branch-transfer-write.ts";
import { latestCiStatus } from "./ci-evidence.ts";
import { requiredCiJobsPassed } from "./ci-required-jobs.ts";
import {
  type PrCiScope,
  prCiScopeDescription,
  readCurrentTransferScope,
} from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import { devMergePolicyEnabled, requireLiveProtection } from "./dev-merge-execution.ts";
import { assertTrustedDevWrite } from "./dev-write-guard.ts";
import { getJsonNumber, getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { assertTrustedMainWrite } from "./main-write-guard.ts";
import { squashManagedPull } from "./managed-pr-squash.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { evaluatePrTrust } from "./pr-trust.ts";
import { takeProtectionReadToken, withProtectionReads } from "./protection-read-scope.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { resolveCiCapabilities } from "./resolve-ci-capabilities.ts";
import { changedFiles, resolveCiControlDecision } from "./resolve-ci-control-ref.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

export function assertTransferCompare(scope: PrCiScope, compare: unknown): void {
  if (
    !isJsonRecord(compare) ||
    compare.status !== "ahead" ||
    getJsonNumber(compare, "behind_by") !== 0 ||
    getJsonNumber(compare, "ahead_by") < 1 ||
    getJsonString(compare.merge_base_commit, "sha") !== scope.baseSha
  ) {
    throw new CliError(
      "Transfer source must include the current target tip; no protected branch refresh is allowed.",
      75
    );
  }
}

export function assertTransferReady(
  scope: PrCiScope,
  expected: string,
  pull: unknown,
  titleFingerprint = ""
): string {
  const title = getJsonString(pull, "title").replace(/[\r\n]/g, " ");
  if (
    prCiScopeDescription(scope) !== expected ||
    !isJsonRecord(pull) ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.mergeable !== true ||
    pull.mergeable_state === "behind" ||
    pull.mergeable_state === "dirty" ||
    getJsonString(pull.base, "sha") !== scope.baseSha ||
    getJsonString(pull.head, "sha") !== scope.headSha ||
    !title ||
    (titleFingerprint !== "" && prTitleFingerprint(title) !== titleFingerprint)
  ) {
    throw new CliError(
      "Authorized transfer snapshot or PR title changed, or PR is not ready.",
      75
    );
  }
  if (!evaluatePrTrust(pull, [], scope.headSha).trusted) {
    throw new CliError("Transfer PR author is not trusted for central CI.", 77);
  }
  return title;
}

async function main(): Promise<void> {
  const protectionToken = takeProtectionReadToken();
  const stage = process.argv[2];
  const repository = process.env.REPOSITORY ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const headSha = process.env.SOURCE_SHA ?? "";
  const prNumber = Number(process.env.PR_NUMBER ?? "");
  const snapshot = process.env.TRANSFER_SNAPSHOT ?? "";
  const isConfirmed = process.env.OPERATOR_CONFIRMED === "true";
  const runId = Number(process.env.GITHUB_RUN_ID ?? "");
  if (
    (stage !== "prepare" && stage !== "execute") ||
    controlRepository !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.OPERATION !== "transfer" ||
    (stage === "execute" && !isConfirmed) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1
  ) {
    throw new CliError("Transfer execution requires a fresh trusted manual workflow.", 75);
  }
  validateRepositoryCapability(repository, JSON.parse(readRepositoryPolicyText()), "pr");
  const controlToken = requireToken("control");
  const reader = withProtectionReads(
    statusAwareReader(
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      controlToken,
      requireToken("status")
    ),
    protectionToken,
    [repository]
  );
  await assertManualBranchAuthorization(
    reader,
    controlRepository,
    repository,
    runId,
    Number(process.env.GITHUB_RUN_ATTEMPT ?? "")
  );
  const repo = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(repo) ||
    repo.private !== false ||
    repo.default_branch !== "main" ||
    repo.full_name !== repository ||
    repository === controlRepository
  ) {
    throw new CliError(
      "Transfer execution currently requires a protected public downstream repository.",
      75
    );
  }
  if (
    !devMergePolicyEnabled(
      JSON.parse(readFileSync("policies/rulesets.json", "utf8")),
      repository,
      controlRepository
    )
  ) {
    throw new CliError("Both managed branches must have enabled strict protected merge policy.", 75);
  }
  await requireLiveProtection(reader, repository, controlRepository);
  if ((await resolveTransferPrNumber(reader, repository, prNumber)) !== prNumber) {
    throw new CliError("Transfer must use the locked PR number.", 75);
  }
  const scope = await readCurrentTransferScope(reader, repository, prNumber, headSha);
  if (!scope) throw new CliError("Transfer snapshot is unavailable.", 75);
  const pullPath = `repos/${repository}/pulls/${prNumber}`;
  const pull = await reader.get(pullPath);
  const titleFingerprint = process.env.TRANSFER_TITLE_FINGERPRINT ?? "";
  if (stage === "execute" && !/^[0-9a-f]{64}$/.test(titleFingerprint)) {
    throw new CliError("Missing locked transfer title fingerprint.", 75);
  }
  const title = assertTransferReady(scope, snapshot, pull, titleFingerprint);
  assertTransferCompare(
    scope,
    await reader.get(`repos/${repository}/compare/${scope.baseSha}...${scope.headSha}`)
  );
  const mainSha = scope.targetBranch === "main" ? scope.baseSha : scope.headSha;
  const devSha = scope.targetBranch === "dev" ? scope.baseSha : scope.headSha;
  await assertTrustedMainWrite(reader, repository, mainSha);
  await assertTrustedDevWrite(reader, repository, devSha, controlRepository);
  const gateContext = transferGateContext(scope.targetBranch);
  const sourceStatuses = await reader.get(`repos/${repository}/commits/${scope.headSha}/status`);
  if (latestCiStatus(sourceStatuses, gateContext)?.state === "success") {
    throw new CliError(
      "Transfer source already carries the target native gate; refuse unsafe head fallback.",
      75
    );
  }

  if (stage === "prepare") {
    const decision = resolveCiControlDecision(
      repository,
      headSha,
      pull,
      await changedFiles(repository, String(prNumber), controlToken),
      scope.targetBranch,
      true
    );
    const controlRef = decision.candidate_control ? scope.headSha : scope.baseSha;
    const capabilities = await resolveCiCapabilities(repository, controlRef, controlToken, false);
    await appendLines(process.env.GITHUB_OUTPUT, [
      `repository=${repository}`,
      `owner=${repository.split("/")[0]}`,
      `repository_name=${repository.split("/")[1]}`,
      `pr_number=${prNumber}`,
      `base_sha=${scope.baseSha}`,
      `head_sha=${scope.headSha}`,
      `merge_sha=${scope.mergeSha}`,
      `target_branch=${scope.targetBranch}`,
      `title=${title}`,
      `title_fingerprint=${prTitleFingerprint(title)}`,
      `control_ref=${controlRef}`,
      `has_windows=${capabilities.has_windows}`,
      `linux_shards=${JSON.stringify(capabilities.linux_shards)}`,
    ]);
    return;
  }

  if (
    !requiredCiJobsPassed(
      process.env.TRANSFER_LINUX_RESULT ?? "",
      process.env.TRANSFER_GOVERNANCE_RESULT ?? "",
      process.env.TRANSFER_WINDOWS_RESULT ?? "",
      process.env.TRANSFER_HAS_WINDOWS ?? ""
    )
  ) {
    throw new CliError("Transfer lacks required governance and central CI jobs.", 75);
  }
  const mergeToken = process.env.AW_MERGE_WRITE_TOKEN ?? "";
  if (!mergeToken) throw new CliError("Missing scoped transfer merge token.", 77);
  const statusToken = requireToken("status");
  const runUrl = `https://github.com/${controlRepository}/actions/runs/${runId}`;
  const publish = async (
    sha: string,
    context: string,
    state: "success" | "failure",
    description: string
  ): Promise<void> => {
    const status = { repository, sha, context, state, description, targetUrl: runUrl };
    await postGithubCommitStatus({
      ...status,
      token: statusToken,
      description: signedStatusDescription(status),
    });
  };
  const requireCurrent = async (): Promise<void> => {
    const current = await readCurrentTransferScope(reader, repository, prNumber, headSha);
    if (!current || prCiScopeDescription(current) !== snapshot) {
      throw new CliError("Transfer snapshot changed; a new manual authorization is required.", 75);
    }
    assertTransferReady(current, snapshot, await reader.get(pullPath), titleFingerprint);
  };
  await requireCurrent();
  // GitHub evaluates statuses on the synthetic merge commit when it has a status.
  // Never grant the target native gate on the protected source head.
  await publish(scope.mergeSha, gateContext, "success", snapshot);
  let writeSha = "";
  try {
    await requireCurrent();
    const result = await squashManagedPull(repository, prNumber, headSha, mergeToken);
    writeSha = result.sha;
  } catch (error) {
    const after = await reader.get(pullPath);
    if (
      isJsonRecord(after) &&
      after.merged === true &&
      getJsonString(after.head, "sha") === headSha
    ) {
      writeSha = getJsonString(after, "merge_commit_sha");
    } else {
      await publish(scope.mergeSha, gateContext, "failure", snapshot);
      throw error;
    }
  }
  verifyTransferCommit(
    scope,
    writeSha,
    await reader.get(pullPath),
    await reader.get(`repos/${repository}/git/commits/${writeSha}`),
    await reader.get(`repos/${repository}/git/commits/${scope.mergeSha}`)
  );
  await publish(
    writeSha,
    transferReceiptContext(scope.targetBranch),
    "success",
    `transfer-v1=${scope.mergeSha}`
  );
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Cross-branch transfer completed",
    "",
    `PR #${prNumber}; verified squash commit ${writeSha}`,
    "The branch-specific write audit independently verifies the signed receipt and exact tree.",
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
