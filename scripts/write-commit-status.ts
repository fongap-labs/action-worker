import { prCiScopeDescription } from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

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
  const scopePrNumber = process.env.AW_CI_SCOPE_PR_NUMBER;
  if (state === "success" && context === "CI Evidence" && scopePrNumber !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(scopePrNumber)) {
      throw new CliError("Invalid CI evidence scope PR number.", 65);
    }
    if (scopePrNumber !== "0") {
      statusDescription = prCiScopeDescription({
        repository,
        prNumber: Number(scopePrNumber),
        targetBranch: process.env.AW_CI_SCOPE_BRANCH ?? "",
        baseSha: process.env.AW_CI_SCOPE_BASE_SHA ?? "",
        headSha: sha,
        mergeSha: process.env.AW_CI_SCOPE_MERGE_SHA ?? "",
      });
    }
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
