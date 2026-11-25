import {
  assertBranchTransferApproval,
  assertExactBranchApproval,
  transferApprovalComment,
} from "./branch-transfer-approval.ts";
import { readCurrentTransferScope } from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import {
  bootstrapApprovalComment,
  branchAuthorizationWorkflow,
  devBootstrapContext,
  verifyBootstrapSource,
} from "./dev-bootstrap.ts";
import { statusAwareReader } from "./github-api.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

async function main(): Promise<void> {
  const stage = process.argv[2];
  const operation = process.env.OPERATION ?? "";
  const repository = process.env.REPOSITORY ?? "";
  const sha = process.env.SOURCE_SHA ?? "";
  const prNumber = Number(process.env.PR_NUMBER ?? "");
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const runId = Number(process.env.GITHUB_RUN_ID ?? "");
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "");
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !["plan", "verify", "approve"].includes(stage ?? "") ||
    !["initialize-dev", "transfer"].includes(operation)
  ) {
    throw new CliError("Branch authorization requires an explicit trusted main dispatch.", 75);
  }
  validateRepositoryCapability(repository, JSON.parse(readRepositoryPolicyText()), "pr");
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    requireToken("control"),
    requireToken("status")
  );
  if (operation === "initialize-dev") {
    const comment = bootstrapApprovalComment(repository, sha, runId, attempt);
    await verifyBootstrapSource(reader, repository, sha, controlRepository, false);
    if (stage === "plan") {
      await appendLines(process.env.GITHUB_STEP_SUMMARY, [
        "## Development initialization authorization",
        "",
        "Approve only this exact source SHA; this operation does not create a branch.",
        "",
        `\`${comment}\``,
      ]);
      return;
    }
    await assertExactBranchApproval(
      reader,
      controlRepository,
      runId,
      attempt,
      comment,
      branchAuthorizationWorkflow
    );
    await verifyBootstrapSource(reader, repository, sha, controlRepository, false);
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
  const comment = transferApprovalComment(scope, runId, attempt);
  if (stage === "plan") {
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Cross-branch transfer authorization",
      "",
      `Target: ${scope.targetBranch}; PR: #${scope.prNumber}`,
      `Base: ${scope.baseSha}; source: ${scope.headSha}; merge: ${scope.mergeSha}`,
      "",
      `\`${comment}\``,
    ]);
    return;
  }
  await assertBranchTransferApproval(
    reader,
    controlRepository,
    scope,
    runId,
    attempt,
    branchAuthorizationWorkflow
  );
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "Exact transfer approval verified.",
    "",
    "No merge, branch update or merge-gate status was issued.",
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
