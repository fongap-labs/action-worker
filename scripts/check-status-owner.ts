import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
} from "./runtime-command.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4) {
    throw new CliError("Usage: check-status-owner.ts <repository> <sha> <run-url> [context]", 64);
  }
  const [repository = "", sha = "", runUrl = "", context = "PR Governance"] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError(`ERROR: invalid repository: ${repository}`, 64);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new CliError("ERROR: invalid commit SHA.", 64);
  }
  if (!runUrl) {
    throw new CliError("ERROR: run URL is required.", 64);
  }
  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("ERROR: GH_TOKEN is required.");
  }
  const response = await getGithubJson(`repos/${repository}/commits/${sha}/status`, token);
  const statuses = getJsonArray(response, "statuses")
    .filter((item) => isJsonRecord(item) && getJsonString(item, "context") === context)
    .sort((left, right) => getJsonString(right, "created_at").localeCompare(getJsonString(left, "created_at")));
  const latest = statuses[0];
  const target = isJsonRecord(latest) ? getJsonString(latest, "target_url") : "";
  if (target === runUrl) {
    await appendLines(process.env.GITHUB_OUTPUT, ["current=true"]);
    console.log(`Current run still owns ${context} for ${repository}@${sha}.`);
    return;
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendLines(process.env.GITHUB_OUTPUT, ["current=false"]);
    console.error(`Current run no longer owns ${context} for ${repository}@${sha}; latest target is ${target || "<none>"}.`);
    return;
  }
  throw new CliError(`Current run no longer owns ${context} for ${repository}@${sha}; latest target is ${target || "<none>"}.`, 3);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
