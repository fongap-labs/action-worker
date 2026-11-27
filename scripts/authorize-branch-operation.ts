import { assertManualBranchAuthorization } from "./branch-transfer-approval.ts";
import { prCiScopeDescription, readCurrentTransferScope } from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import { initializeProtectedDev } from "./create-protected-dev.ts";
import {
  bootstrapApprovalComment,
  devBootstrapContext,
  verifyBootstrapSource,
} from "./dev-bootstrap-authorization.ts";
import { getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { takeProtectionReadToken, withProtectionReads } from "./protection-read-scope.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

const shaPattern = /^[0-9a-f]{40}$/;

function isDevBootstrap(operation: string): boolean {
  return operation === "initialize-dev" || operation === "adopt-dev";
}

export async function resolveBranchSourceSha(
  reader: { get(path: string): Promise<unknown> },
  operation: string,
  repository: string,
  prNumber: number,
  requestedSha: string
): Promise<string> {
  if (
    (!isDevBootstrap(operation) && operation !== "transfer") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    (isDevBootstrap(operation) ? prNumber !== 0 : prNumber < 1)
  ) {
    throw new CliError("Invalid branch authorization target.", 65);
  }
  const requested = requestedSha.trim().toLowerCase();
  if (requested) {
    if (!shaPattern.test(requested)) {
      throw new CliError("Source SHA must be a full 40-character Git commit SHA.", 65);
    }
    return requested;
  }
  const initialize = isDevBootstrap(operation);
  const path = initialize
    ? `repos/${repository}/branches/main`
    : `repos/${repository}/pulls/${prNumber}`;
  const value = await reader.get(path);
  const sha = isJsonRecord(value)
    ? getJsonString(initialize ? value.commit : value.head, "sha")
    : "";
  if (!shaPattern.test(sha)) {
    throw new CliError("Current source SHA is unavailable.", 75);
  }
  return sha;
}

async function main(): Promise<void> {
  const protectionToken = takeProtectionReadToken();
  const stage = process.argv[2];
  const operation = process.env.OPERATION ?? "";
  const repository = process.env.REPOSITORY ?? "";
  const requestedSha = process.env.SOURCE_SHA ?? "";
  const prNumber = Number(process.env.PR_NUMBER ?? "");
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const runId = Number(process.env.GITHUB_RUN_ID ?? "");
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "");
  const confirmed = process.env.OPERATOR_CONFIRMED === "true";
  const snapshot = process.env.TRANSFER_SNAPSHOT ?? "";
  if (
    controlRepository !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !["plan", "verify", "approve"].includes(stage ?? "") ||
    (!isDevBootstrap(operation) && operation !== "transfer") ||
    !Number.isSafeInteger(prNumber) ||
    (isDevBootstrap(operation) ? prNumber !== 0 || snapshot !== "" : prNumber < 1)
  ) {
    throw new CliError("Branch authorization requires an explicit trusted main dispatch.", 75);
  }
  if (stage !== "plan" && !confirmed) {
    throw new CliError("Explicit operator confirmation is required.", 77);
  }
  if (stage !== "plan" && !shaPattern.test(requestedSha)) {
    throw new CliError("A locked source SHA from the plan is required.", 75);
  }
  validateRepositoryCapability(repository, JSON.parse(readRepositoryPolicyText()), "pr");
  const reader = withProtectionReads(
    statusAwareReader(
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      requireToken("control"),
      requireToken("status")
    ),
    protectionToken,
    [repository]
  );
  await assertManualBranchAuthorization(reader, controlRepository, repository, runId, attempt);
  const sha =
    stage === "plan"
      ? await resolveBranchSourceSha(reader, operation, repository, prNumber, requestedSha)
      : requestedSha;
  if (isDevBootstrap(operation)) {
    const adopt = operation === "adopt-dev";
    const identity = bootstrapApprovalComment(repository, sha, runId, attempt);
    await verifyBootstrapSource(reader, repository, sha, controlRepository, adopt);
    if (stage === "plan") {
      await appendLines(process.env.GITHUB_OUTPUT, [`source_sha=${sha}`, "transfer_snapshot="]);
      await appendLines(process.env.GITHUB_STEP_SUMMARY, [
        "## Development initialization authorization",
        "",
        adopt
          ? "Existing dev and trusted main must match exactly; adoption does not move any ref."
          : "Source and administrator identity verified; the check stage does not create a branch.",
        `Source SHA: ${sha} (${requestedSha.trim() ? "manual" : "automatic"})`,
        "",
        `\`${identity}\``,
        confirmed ? "Explicit authorization requested." : "Check only; no receipt will be issued.",
      ]);
      return;
    }
    if (stage === "verify") return;
    const status = {
      repository,
      sha,
      state: "success" as const,
      context: devBootstrapContext,
      description: `init-v1=${sha}`,
      targetUrl: `https://github.com/${controlRepository}/actions/runs/${runId}`,
    };
    await postGithubCommitStatus({
      ...status,
      token: requireToken("status"),
      description: signedStatusDescription(status),
    });
    const refToken = process.env.AW_DEV_REF_TOKEN ?? "";
    delete process.env.AW_DEV_REF_TOKEN;
    if (!adopt) {
      await initializeProtectedDev(
        process.env.GITHUB_API_URL ?? "https://api.github.com",
        protectionToken,
        refToken,
        repository,
        sha
      );
    }
    await verifyBootstrapSource(reader, repository, sha, controlRepository, true);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Development initialization completed",
      "",
      adopt
        ? `Verified existing ${repository}@dev at ${sha}; no ref or protection changed.`
        : `Created and verified ${repository}@dev at ${sha}; closed branch protection restored.`,
      "Dev merge enrollment remains subject to the existing Dev Write Guard and central policy.",
    ]);
    return;
  }
  const scope = await readCurrentTransferScope(reader, repository, prNumber, sha);
  if (!scope) throw new CliError("Branch transfer snapshot is not ready.", 75);
  const expected = prCiScopeDescription(scope);
  if (stage === "plan") {
    if (snapshot && snapshot !== expected) {
      throw new CliError("Specified branch transfer snapshot is no longer current.", 75);
    }
    await appendLines(process.env.GITHUB_OUTPUT, [
      `source_sha=${sha}`,
      `transfer_snapshot=${expected}`,
    ]);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Cross-branch transfer authorization",
      "",
      `Target: ${scope.targetBranch}; PR: #${scope.prNumber}`,
      `Base: ${scope.baseSha}; source: ${scope.headSha}; merge: ${scope.mergeSha}`,
      "",
      `\`${expected}\``,
      `Source SHA: ${sha} (${requestedSha.trim() ? "manual" : "automatic"})`,
      confirmed
        ? "This exact snapshot is locked for verification and authorization in this run."
        : "Check only; confirm a new manual run to authorize. Optionally specify this snapshot to require an exact match.",
    ]);
    return;
  }
  if (snapshot !== expected) {
    throw new CliError("Exact branch transfer snapshot is missing or changed.", 75);
  }
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "Exact administrator transfer authorization verified.",
    "",
    "No merge, branch update or merge-gate status was issued.",
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
