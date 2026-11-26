import { assertManualBranchAuthorization } from "./branch-transfer-approval.ts";
import { prCiScopeDescription, readCurrentTransferScope } from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import {
  bootstrapApprovalComment,
  devBootstrapContext,
  verifyBootstrapSource,
} from "./dev-bootstrap-authorization.ts";
import { statusAwareReader } from "./github-api.ts";
import { takeProtectionReadToken, withProtectionReads } from "./protection-read-scope.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

async function main(): Promise<void> {
  const protectionToken = takeProtectionReadToken();
  const stage = process.argv[2];
  const operation = process.env.OPERATION ?? "";
  const repository = process.env.REPOSITORY ?? "";
  const sha = process.env.SOURCE_SHA ?? "";
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
    !["initialize-dev", "transfer"].includes(operation) ||
    (operation === "initialize-dev" && (prNumber !== 0 || snapshot !== ""))
  ) {
    throw new CliError("Branch authorization requires an explicit trusted main dispatch.", 75);
  }
  if (stage !== "plan" && !confirmed) {
    throw new CliError("Explicit operator confirmation is required.", 77);
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
  if (operation === "initialize-dev") {
    const identity = bootstrapApprovalComment(repository, sha, runId, attempt);
    await verifyBootstrapSource(reader, repository, sha, controlRepository, false);
    if (stage === "plan") {
      await appendLines(process.env.GITHUB_STEP_SUMMARY, [
        "## Development initialization authorization",
        "",
        "Source and administrator identity verified; this operation does not create a branch.",
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
    return;
  }
  const scope = await readCurrentTransferScope(reader, repository, prNumber, sha);
  if (!scope) throw new CliError("Branch transfer snapshot is not ready.", 75);
  const expected = prCiScopeDescription(scope);
  if (stage === "plan") {
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Cross-branch transfer authorization",
      "",
      `Target: ${scope.targetBranch}; PR: #${scope.prNumber}`,
      `Base: ${scope.baseSha}; source: ${scope.headSha}; merge: ${scope.mergeSha}`,
      "",
      `\`${expected}\``,
      "Copy this snapshot into transfer_snapshot and explicitly confirm a new manual run.",
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
