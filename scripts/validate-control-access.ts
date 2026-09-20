import {
  getGithubJson,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  runCommand,
} from "./runtime-command.ts";

async function checkAccess(path: string, token: string, message: string): Promise<void> {
  try {
    await runCommand("gh", ["api", path], { env: { ...process.env, GH_TOKEN: token } });
  } catch {
    throw new CliError(message);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new CliError("Usage: validate-control-access.ts <repository> <pr-number>", 64);
  }
  const [repository = "", prNumber = ""] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError("::error::Invalid control target repository.", 65);
  }
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new CliError("::error::Invalid control target PR number.", 65);
  }
  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("::error::CONTROL_TOKEN is required.");
  }
  let pull: unknown;
  try {
    pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
  } catch {
    throw new CliError("::error::CONTROL_TOKEN cannot read the target PR; Pull Requests Read is required.");
  }
  const head = isJsonRecord(pull) && isJsonRecord(pull.head) ? getJsonString(pull.head, "sha") : "";
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new CliError("::error::Unable to resolve target PR head SHA.", 65);
  }
  await checkAccess(`repos/${repository}/actions/runs?per_page=1`, token, "::error::CONTROL_TOKEN cannot read target Actions; Actions Read is required.");
  await checkAccess(`repos/${repository}/commits/${head}/status`, token, "::error::CONTROL_TOKEN cannot read target commit status; Commit Statuses Read/Write is required.");
  console.log(`repository=${repository}`);
  console.log(`pr_number=${prNumber}`);
  console.log(`head_sha=${head}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
