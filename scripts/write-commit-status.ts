import { runGithubCli } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { requireStatusToken, signedStatusDescription } from "./status-attestation.ts";

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
  const signingKey = requireStatusToken();
  // Status API authorization is independent of the durable HMAC signing key.
  // Legacy callers retain their existing credential until their workflows migrate.
  const apiToken = process.env.AW_STATUS_API_TOKEN ?? signingKey;
  if (!apiToken) throw new CliError("::error::Missing status API credential.", 77);
  const signedDescription = signedStatusDescription(
    { repository, sha, state, context, description, targetUrl },
    signingKey
  );
  await runGithubCli(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/statuses/${sha}`,
      "-f",
      `state=${state}`,
      "-f",
      `context=${context}`,
      "-f",
      `description=${signedDescription}`,
      "-f",
      `target_url=${targetUrl}`,
    ],
    apiToken
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
