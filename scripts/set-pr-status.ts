import {
  CliError,
  handleError,
  isMain,
} from "./runtime-command.ts";
import { runGithubCli } from "./github-api.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 4 || args.length > 5) {
    throw new CliError("Usage: set-pr-status.ts <repository> <sha> <state> <description> [target-url]", 64);
  }
  const [repository = "", sha = "", state = "", description = "", targetUrl = ""] = args;
  const context = process.env.PR_STATUS_CONTEXT ?? "PR Governance";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError(`::error::Invalid repository: ${repository}.`, 64);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new CliError("::error::Invalid commit SHA.", 64);
  }
  if (!["pending", "success", "failure", "error"].includes(state)) {
    throw new CliError(`::error::Invalid commit status state: ${state}.`, 64);
  }
  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("::error::GH_TOKEN is required.");
  }
  const command = [
    "api", "--method", "POST", `repos/${repository}/statuses/${sha}`,
    "-f", `state=${state}`,
    "-f", `context=${context}`,
    "-f", `description=${description}`,
  ];
  if (targetUrl) {
    command.push("-f", `target_url=${targetUrl}`);
  }
  await runGithubCli(command, token);
  console.log(`PR status updated: ${repository}@${sha} ${context}=${state}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
