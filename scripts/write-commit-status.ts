import { prCiScopeDescription } from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import { gateContextsForBranch, loadGateContract } from "./governance-gate-contract.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

export function resolveCiSuccessDescription(
  repository: string,
  sha: string,
  context: string,
  description: string,
  env: NodeJS.ProcessEnv
): string {
  const contract = loadGateContract();
  const main = contract.status_contexts.ci_evidence;
  const dev = contract.dev_status_contexts.ci_evidence;
  if (context !== main && context !== dev) return description;
  const number = env.AW_CI_SCOPE_PR_NUMBER;
  if (number === undefined || number === "0") {
    if (context === dev || (env.AW_CI_SCOPE_BRANCH && env.AW_CI_SCOPE_BRANCH !== "main")) {
      throw new CliError("Dev CI success requires an explicit PR snapshot scope.", 65);
    }
    return description;
  }
  if (!/^[1-9][0-9]*$/.test(number)) {
    throw new CliError("Invalid CI evidence scope PR number.", 65);
  }
  const targetBranch = env.AW_CI_SCOPE_BRANCH ?? "";
  if (gateContextsForBranch(contract, targetBranch).ci_evidence !== context) {
    throw new CliError("CI status context does not match the target branch.", 65);
  }
  return prCiScopeDescription({
    repository,
    prNumber: Number(number),
    targetBranch,
    baseSha: env.AW_CI_SCOPE_BASE_SHA ?? "",
    headSha: sha,
    mergeSha: env.AW_CI_SCOPE_MERGE_SHA ?? "",
  });
}

async function main(): Promise<void> {
  const [repository = "", sha = "", rawState = "", context = "", description = "", targetUrl = ""] =
    process.argv.slice(2);
  if (!repository || !sha || !context || !description || !targetUrl) {
    throw new CliError(
      "Usage: write-commit-status.ts <repository> <sha> <state> <context> <description> <target-url>",
      64
    );
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    !["pending", "success", "failure", "error"].includes(rawState)
  ) {
    throw new CliError("Invalid commit status subject or state.", 64);
  }
  const state = rawState as "pending" | "success" | "failure" | "error";
  const apiToken = requireToken("status");
  const failureFingerprint = process.env.AW_CI_FAILURE_FINGERPRINT ?? "";
  let statusDescription =
    state === "failure" &&
    context === "CI Evidence" &&
    /^[RN](?:\d{1,5})?:[0-9a-f]{62}$/.test(failureFingerprint)
      ? failureFingerprint
      : description;
  if (state === "success") {
    statusDescription = resolveCiSuccessDescription(
      repository,
      sha,
      context,
      statusDescription,
      process.env
    );
  }
  const signedDescription = signedStatusDescription({
    repository,
    sha,
    state,
    context,
    description: statusDescription,
    targetUrl,
  });
  await postGithubCommitStatus({
    repository,
    sha,
    token: apiToken,
    state,
    context,
    description: signedDescription,
    targetUrl,
  });
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
