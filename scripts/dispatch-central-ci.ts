import {
  githubEnvironment,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";
import { isJsonRecord } from "./github-api.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 6) {
    throw new CliError(
      "Usage: dispatch-central-ci.ts <repository> <pr-number> <request-id> <head-sha> <run-url> <policy-file>",
      64,
    );
  }

  const [repository = "", prNumber = "", requestId = "", headSha = "", runUrl = "", policyPath = ""] = args;
  if (!repositoryPattern.test(repository)) {
    throw new CliError("::error::Invalid central CI repository.", 64);
  }
  if (!/^\d+$/.test(prNumber) || Number(prNumber) < 1) {
    throw new CliError("::error::Invalid central CI PR number.", 64);
  }
  if (!requestId || requestId.length > 128) {
    throw new CliError("::error::Invalid central CI request id.", 64);
  }
  if (!shaPattern.test(headSha)) {
    throw new CliError("::error::Invalid central CI head SHA.", 64);
  }

  const policy = await readJson(policyPath);
  const ci = isJsonRecord(policy) && isJsonRecord(policy.ci) ? policy.ci : {};
  const repositories = Array.isArray(ci.central_repositories)
    ? ci.central_repositories.filter((item): item is string => typeof item === "string")
    : [];
  if (!repositories.includes(repository)) {
    console.log(`Central CI dispatch skipped: ${repository}`);
    return;
  }

  const context = typeof ci.status_context === "string" && ci.status_context
    ? ci.status_context
    : "CI Evidence";
  const token = process.env.GH_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !repositoryPattern.test(controlRepository)) {
    throw new CliError("::error::Central CI control credentials are unavailable.", 65);
  }

  const statusArgs = [
    "api",
    "--method",
    "POST",
    `repos/${repository}/statuses/${headSha}`,
    "-f",
    "state=pending",
    "-f",
    `context=${context}`,
    "-f",
    "description=Central CI in progress",
  ];
  if (runUrl) {
    statusArgs.push("-f", `target_url=${runUrl}`);
  }
  await runGithubCli(statusArgs, token);

  const payload = JSON.stringify({
    event_type: "run-central-ci",
    client_payload: {
      schema_version: "1",
      request_id: requestId,
      repository,
      pr_number: Number(prNumber),
      head_sha: headSha,
    },
  });

  await runText(
    "gh",
    ["api", "--method", "POST", `repos/${controlRepository}/dispatches`, "--input", "-"],
    {
      env: githubEnvironment(token),
      input: payload,
    },
  );
  console.log(`Central CI dispatched: ${repository}#${prNumber}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
