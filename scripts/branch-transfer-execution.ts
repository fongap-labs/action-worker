import { readFileSync } from "node:fs";
import { resolveTransferPrNumber } from "./authorize-branch-operation.ts";
import { assertManualBranchAuthorization } from "./branch-transfer-approval.ts";
import {
  readTransferPlan,
  type TransferIntent,
  transferIntentDescription,
  transferPlanDescription,
} from "./branch-transfer-intent.ts";
import {
  closeOriginalTransfer,
  closeUnusedStagedTransfer,
  createStagedTransfer,
  transferStageWriter,
  verifyStagedTransferProof,
} from "./branch-transfer-staging.ts";
import {
  transferGateContext,
  transferReceiptContext,
  verifyTransferCommit,
} from "./branch-transfer-write.ts";
import { type JsonReader, latestCiStatus } from "./ci-evidence.ts";
import { requiredCiJobsPassed } from "./ci-required-jobs.ts";
import {
  type PrCiScope,
  prCiScopeDescription,
  readCurrentStagedTransferScope,
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
import { isManagedTransferDirection, isStagedTransferDirection } from "./resolve-pr-facts.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import {
  hasValidStatusAttestation,
  originalStatusDescription,
  signedStatusDescription,
  statusRunAttempt,
} from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

export function transferSnapshotTree(scope: PrCiScope, commit: unknown): string {
  if (
    !isJsonRecord(commit) ||
    getJsonString(commit, "sha") !== scope.mergeSha ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 2 ||
    getJsonString(commit.parents[0], "sha") !== scope.baseSha ||
    getJsonString(commit.parents[1], "sha") !== scope.headSha ||
    !/^[0-9a-f]{40}$/.test(getJsonString(commit.tree, "sha"))
  ) {
    throw new CliError("Transfer snapshot has invalid parents or tree.", 75);
  }
  return getJsonString(commit.tree, "sha");
}

export async function requireEquivalentTransferSnapshot(
  reader: JsonReader,
  authorized: PrCiScope,
  current: PrCiScope
): Promise<void> {
  if (
    authorized.repository !== current.repository ||
    authorized.prNumber !== current.prNumber ||
    authorized.targetBranch !== current.targetBranch ||
    authorized.baseSha !== current.baseSha ||
    authorized.headSha !== current.headSha
  ) {
    throw new CliError("Transfer identity changed; a new authorization is required.", 75);
  }
  const prefix = `repos/${authorized.repository}/git/commits/`;
  const original = transferSnapshotTree(authorized, await reader.get(prefix + authorized.mergeSha));
  if (
    authorized.mergeSha !== current.mergeSha &&
    original !== transferSnapshotTree(current, await reader.get(prefix + current.mergeSha))
  ) {
    throw new CliError("Transfer tree changed; a new authorization and CI are required.", 75);
  }
}

/** Native GitHub status is SHA-scoped, not PR-scoped. Refuse any known competing target PR. */
export async function requireExclusiveTransferHead(
  reader: JsonReader,
  scope: PrCiScope
): Promise<void> {
  const matching: number[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const pulls = await reader.get(
      `repos/${scope.repository}/pulls?state=open&base=${scope.targetBranch}&per_page=100&page=${page}`
    );
    if (!Array.isArray(pulls)) {
      throw new CliError("Transfer head exclusivity cannot be established.", 75);
    }
    for (const pull of pulls) {
      if (
        !isJsonRecord(pull) ||
        pull.state !== "open" ||
        getJsonString(pull.base, "ref") !== scope.targetBranch ||
        !/^[0-9a-f]{40}$/.test(getJsonString(pull.head, "sha")) ||
        getJsonNumber(pull, "number") < 1
      ) {
        throw new CliError("Transfer head exclusivity cannot be established.", 75);
      }
      if (getJsonString(pull.head, "sha") === scope.headSha) {
        matching.push(getJsonNumber(pull, "number"));
      }
    }
    if (pulls.length < 100) {
      if (matching.length !== 1 || matching[0] !== scope.prNumber) {
        throw new CliError(
          "Another target PR shares the transfer head, or the PR is no longer open.",
          75
        );
      }
      return;
    }
  }
  throw new CliError("Transfer head exclusivity scan exceeded its bound.", 75);
}

type TransferPublisher = (
  sha: string,
  context: string,
  state: "success" | "failure",
  description: string
) => Promise<void>;

/** Close only this run's signed temporary gate. Never revoke a different publisher's gate. */
export async function revokeTransferHeadGate(
  reader: JsonReader,
  repository: string,
  headSha: string,
  targetBranch: string,
  snapshot: string,
  runUrl: string,
  publish: TransferPublisher,
  isRevocationRequired = false,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  const context = transferGateContext(targetBranch);
  const path = `repos/${repository}/commits/${headSha}/status`;
  let hasRevokedGate = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = latestCiStatus(await reader.get(path), context);
    if (latest && getJsonString(latest, "target_url") === runUrl) {
      if (
        !hasValidStatusAttestation(latest, { repository, sha: headSha, context }) ||
        statusRunAttempt(latest) !== 1 ||
        originalStatusDescription(latest) !== snapshot
      ) {
        throw new CliError("Refusing to revoke a mismatched transfer head gate.", 75);
      }
      if (latest.state === "failure") return;
      if (latest.state !== "success") {
        throw new CliError("Unexpected transfer head gate state.", 75);
      }
      if (!hasRevokedGate) {
        await publish(headSha, context, "failure", snapshot);
        hasRevokedGate = true;
      }
    } else {
      if (!isRevocationRequired && !hasRevokedGate) return;
      if (latest?.state === "success") {
        throw new CliError("A different publisher owns the active target gate.", 75);
      }
    }
    if (attempt < 4) await wait(1000);
  }
  throw new CliError("Could not confirm withdrawal of the temporary transfer head gate.", 75);
}

export function assertTransferCompare(scope: PrCiScope, compare: unknown): void {
  if (
    !isJsonRecord(compare) ||
    compare.status !== "ahead" ||
    compare.behind_by !== 0 ||
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
  titleFingerprint = "",
  stagingRef = ""
): string {
  const title = getJsonString(pull, "title").replace(/[\r\n]/g, " ");
  if (
    prCiScopeDescription(scope) !== expected ||
    !isJsonRecord(pull) ||
    pull.number !== scope.prNumber ||
    (stagingRef
      ? !isStagedTransferDirection(pull, scope.repository) ||
        getJsonString(pull.head, "ref") !== stagingRef
      : !isManagedTransferDirection(pull, scope.repository)) ||
    getJsonString(pull.base, "ref") !== scope.targetBranch ||
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
    throw new CliError("Authorized transfer snapshot or PR title changed, or PR is not ready.", 75);
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
  let headSha = process.env.SOURCE_SHA ?? "";
  let prNumber = Number(process.env.PR_NUMBER ?? "");
  let snapshot = process.env.TRANSFER_SNAPSHOT ?? "";
  let stagingRef = process.env.TRANSFER_STAGING_REF ?? "";
  const isConfirmed = process.env.OPERATOR_CONFIRMED === "true";
  const runId = Number(process.env.GITHUB_RUN_ID ?? "");
  if (
    (stage !== "prepare" && stage !== "execute" && stage !== "cleanup") ||
    controlRepository !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.OPERATION !== "transfer" ||
    (stage !== "prepare" && !isConfirmed) ||
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
  const runUrl = `https://github.com/${controlRepository}/actions/runs/${runId}`;
  const publish: TransferPublisher = async (sha, context, state, description) => {
    const status = { repository, sha, context, state, description, targetUrl: runUrl };
    await postGithubCommitStatus({
      ...status,
      token: requireToken("status"),
      description: signedStatusDescription(status),
    });
  };
  if (stage === "cleanup") {
    if (
      process.env.GITHUB_RUN_ATTEMPT !== "1" ||
      !/^[0-9a-f]{40}$/.test(headSha) ||
      !/^scope-v1=[A-Za-z0-9_-]{43}$/.test(snapshot)
    ) {
      throw new CliError("Invalid transfer cleanup scope.", 75);
    }
    await revokeTransferHeadGate(
      reader,
      repository,
      headSha,
      process.env.TRANSFER_TARGET_BRANCH ?? "",
      snapshot,
      runUrl,
      publish
    );
    if (stagingRef) {
      await closeUnusedStagedTransfer(
        reader,
        transferStageWriter(process.env.AW_TRANSFER_CLEANUP_TOKEN ?? ""),
        repository,
        prNumber,
        headSha,
        stagingRef,
        runId,
        runUrl
      );
    }
    return;
  }
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
    throw new CliError(
      "Both managed branches must have enabled strict protected merge policy.",
      75
    );
  }
  await requireLiveProtection(reader, repository, controlRepository);
  const originalPr = stagingRef ? Number(process.env.TRANSFER_ORIGINAL_PR ?? "") : prNumber;
  const originalHead = stagingRef ? process.env.TRANSFER_ORIGINAL_HEAD ?? "" : headSha;
  const originalSnapshot = stagingRef ? process.env.TRANSFER_ORIGINAL_SNAPSHOT ?? "" : snapshot;
  const titleFingerprint = process.env.TRANSFER_TITLE_FINGERPRINT ?? "";
  if (stage === "execute" && !/^[0-9a-f]{64}$/.test(titleFingerprint)) {
    throw new CliError("Missing locked transfer title fingerprint.", 75);
  }
  if ((await resolveTransferPrNumber(reader, repository, originalPr)) !== originalPr) {
    throw new CliError("Transfer must use the locked original PR number.", 75);
  }

  const requireOriginalPlan = async (expectedTitle = titleFingerprint) => {
    const plan = await readTransferPlan(reader, repository, originalPr, originalHead);
    if (
      transferPlanDescription(plan) !== originalSnapshot ||
      (expectedTitle && prTitleFingerprint(plan.title) !== expectedTitle)
    ) {
      throw new CliError("Original transfer intent or title changed; authorize again.", 75);
    }
    return plan;
  };

  let stagedIntent: TransferIntent | undefined;
  let observed: PrCiScope | undefined;
  let originalTitle = "";
  if (stage === "prepare" || stagingRef) {
    const plan = await requireOriginalPlan();
    originalTitle = plan.title;
    const original = plan.kind === "direct" ? plan.scope : plan.intent;
    const mainSha = original.targetBranch === "main" ? original.baseSha : originalHead;
    const devSha = original.targetBranch === "dev" ? original.baseSha : originalHead;
    await assertTrustedMainWrite(reader, repository, mainSha);
    await assertTrustedDevWrite(reader, repository, devSha, controlRepository);
    if (plan.kind === "noop") {
      if (stage !== "prepare") {
        throw new CliError("Original transfer became empty after preparation.", 75);
      }
      await appendLines(process.env.GITHUB_STEP_SUMMARY, [
        "## No content transfer required",
        "The protected source is already represented in the target. Neither branch was changed.",
      ]);
      return;
    }
    if (stage === "prepare" && !isConfirmed) {
      await appendLines(process.env.GITHUB_STEP_SUMMARY, [
        `Transfer mode: ${plan.kind}. Check only; no staging ref, PR or merge gate was created.`,
      ]);
      return;
    }
    if (plan.kind === "direct") {
      if (stagingRef) throw new CliError("Staged transfer cannot become a direct transfer.", 75);
      observed = plan.scope;
    } else {
      stagedIntent = plan.intent;
      if (stage === "prepare") {
        const prepared = await createStagedTransfer(
          reader,
          transferStageWriter(process.env.AW_TRANSFER_STAGE_TOKEN ?? ""),
          publish,
          stagedIntent,
          originalTitle,
          runId,
          async () => {
            const current = await requireOriginalPlan(prTitleFingerprint(originalTitle));
            if (current.kind !== "staged") {
              throw new CliError("Original staged transfer intent changed.", 75);
            }
          }
        );
        observed = prepared.scope;
        stagingRef = prepared.ref;
        headSha = observed.headSha;
        prNumber = observed.prNumber;
        snapshot = prCiScopeDescription(observed);
      } else {
        observed = await readCurrentStagedTransferScope(reader, repository, prNumber, headSha, stagingRef);
      }
    }
  } else {
    observed = await readCurrentTransferScope(reader, repository, prNumber, headSha);
  }
  if (!observed) throw new CliError("Transfer snapshot is unavailable.", 75);
  const scope =
    stage === "execute"
      ? { ...observed, mergeSha: process.env.TRANSFER_MERGE_SHA ?? "" }
      : observed;
  if (prCiScopeDescription(scope) !== snapshot) {
    throw new CliError("Transfer snapshot changed; a new manual authorization is required.", 75);
  }
  await requireEquivalentTransferSnapshot(reader, scope, observed);
  const pullPath = `repos/${repository}/pulls/${prNumber}`;
  const pull = await reader.get(pullPath);
  const title = assertTransferReady(scope, snapshot, pull, titleFingerprint, stagingRef);
  if (originalTitle && title !== originalTitle) {
    throw new CliError("Staged PR title differs from the authorized original.", 75);
  }
  assertTransferCompare(
    scope,
    await reader.get(`repos/${repository}/compare/${scope.baseSha}...${scope.headSha}`)
  );
  if (stage === "execute" && !stagingRef) {
    const mainSha = scope.targetBranch === "main" ? scope.baseSha : scope.headSha;
    const devSha = scope.targetBranch === "dev" ? scope.baseSha : scope.headSha;
    await assertTrustedMainWrite(reader, repository, mainSha);
    await assertTrustedDevWrite(reader, repository, devSha, controlRepository);
  }
  const requireStagingProof = async () => {
    if (!stagingRef || !stagedIntent) return;
    const current = await requireOriginalPlan(prTitleFingerprint(title));
    if (current.kind !== "staged") {
      throw new CliError("Original transfer intent changed before merge.", 75);
    }
    const proof = await verifyStagedTransferProof(reader, scope, stagingRef, runId, runUrl);
    if (transferIntentDescription(proof.intent) !== transferPlanDescription(current)) {
      throw new CliError("Staged transfer proof does not match the live original intent.", 75);
    }
  };
  if (stage === "execute") await requireStagingProof();
  const gateContext = transferGateContext(scope.targetBranch);
  const sourceStatuses = await reader.get(`repos/${repository}/commits/${scope.headSha}/status`);
  if (latestCiStatus(sourceStatuses, gateContext)?.state === "success") {
    throw new CliError(
      "Transfer source already carries the target native gate; refuse unsafe head fallback.",
      75
    );
  }

  if (stage === "prepare") {
    try {
      // For a staged PR, check the original maintainer trust against the actual staged diff.
      const originalPull = stagingRef
        ? await reader.get(`repos/${repository}/pulls/${originalPr}`)
        : pull;
      const decision = resolveCiControlDecision(
        repository,
        originalHead,
        originalPull,
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
        `transfer_snapshot=${snapshot}`,
        `staging_ref=${stagingRef}`,
        `original_pr=${originalPr}`,
        `original_head=${originalHead}`,
        `original_snapshot=${originalSnapshot}`,
        `control_ref=${controlRef}`,
        `has_windows=${capabilities.has_windows}`,
        `linux_shards=${JSON.stringify(capabilities.linux_shards)}`,
      ]);
    } catch (error) {
      if (stagingRef) {
        await closeUnusedStagedTransfer(
          reader,
          transferStageWriter(process.env.AW_TRANSFER_STAGE_TOKEN ?? ""),
          repository,
          prNumber,
          headSha,
          stagingRef,
          runId,
          runUrl
        );
      }
      throw error;
    }
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
  let hasAttemptedHeadGrant = false;
  const closeHeadGate = () =>
    revokeTransferHeadGate(
      reader,
      repository,
      headSha,
      scope.targetBranch,
      snapshot,
      runUrl,
      publish,
      hasAttemptedHeadGrant
    );
  const requireCurrent = async (): Promise<PrCiScope> => {
    await requireStagingProof();
    const current = stagingRef
      ? await readCurrentStagedTransferScope(reader, repository, prNumber, headSha, stagingRef)
      : await readCurrentTransferScope(reader, repository, prNumber, headSha);
    if (!current) {
      throw new CliError("Transfer snapshot changed; a new manual authorization is required.", 75);
    }
    await requireEquivalentTransferSnapshot(reader, scope, current);
    assertTransferReady(scope, snapshot, await reader.get(pullPath), titleFingerprint, stagingRef);
    await requireExclusiveTransferHead(reader, scope);
    return current;
  };
  const current = await requireCurrent();
  const signedSnapshots = new Set([scope.mergeSha, current.mergeSha]);
  let writeSha = "";
  let hasIssuedReceipt = false;
  try {
    // Preserve the tested snapshot proof. A refreshed test merge commit has the same
    // parents and tree, but GitHub may generate a new SHA during the merge API call.
    for (const sha of signedSnapshots) await publish(sha, gateContext, "success", snapshot);
    // The target native gate is distinct from the source branch's own gate.
    // This temporary status covers GitHub's documented head fallback only.
    await requireExclusiveTransferHead(reader, scope);
    const latestHeadStatuses = await reader.get(`repos/${repository}/commits/${headSha}/status`);
    if (latestCiStatus(latestHeadStatuses, gateContext)?.state === "success") {
      throw new CliError("Another target gate became active before transfer execution.", 75);
    }
    hasAttemptedHeadGrant = true;
    await publish(headSha, gateContext, "success", snapshot);
    const latest = await requireCurrent();
    if (!signedSnapshots.has(latest.mergeSha)) {
      signedSnapshots.add(latest.mergeSha);
      await publish(latest.mergeSha, gateContext, "success", snapshot);
    }
    try {
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
    await closeHeadGate();
    await publish(
      writeSha,
      transferReceiptContext(scope.targetBranch),
      "success",
      `transfer-v1=${scope.mergeSha}`
    );
    hasIssuedReceipt = true;
  } finally {
    try {
      await closeHeadGate();
    } finally {
      for (const sha of signedSnapshots) {
        if (!hasIssuedReceipt || sha !== scope.mergeSha) {
          await publish(sha, gateContext, "failure", snapshot);
        }
      }
    }
  }
  if (stagedIntent) {
    try {
      await closeOriginalTransfer(reader, transferStageWriter(mergeToken), stagedIntent, writeSha);
    } catch {
      console.log("::warning::Staged transfer merged; original PR closure requires inspection.");
    }
  }
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
