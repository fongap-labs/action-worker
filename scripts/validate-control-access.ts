import { getJsonString, GithubHttpError, GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

export async function checkAccess(path: string, token: string, permissionMessage: string): Promise<unknown> {
  const reader = new GithubReader("https://api.github.com", token, {
    attemptLimit: 2,
    timeoutMs: 15_000,
  });
  try {
    return await reader.get(path);
  } catch (error) {
    if (error instanceof GithubHttpError) {
      if (error.kind === "primary-rate-limit") {
        const reset = error.resetAtMs
          ? ` Reset at ${new Date(error.resetAtMs).toISOString()}.`
          : "";
        throw new CliError(
          `::error::GitHub primary API quota exhausted during control-read validation.${reset} Retry after reset.`,
          75
        );
      }
      if (error.kind === "secondary-rate-limit") {
        throw new CliError(
          "::error::GitHub secondary API limit during control-read validation. Respect Retry-After.",
          75
        );
      }
      if (error.status === 401) {
        throw new CliError("::error::Repository read credential rejected (HTTP 401).", 77);
      }
      if (error.status === 403 || error.status === 404) {
        throw new CliError(permissionMessage, 77);
      }
      throw new CliError(`::error::GitHub API returned HTTP ${error.status} during control-read validation.`, 69);
    }
    throw new CliError(
      "::error::Control-read verification failed due to a transport or response error.",
      69
    );
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
    throw new CliError("::error::A repository-scoped GitHub read credential is required.", 77);
  }
  const pull = await checkAccess(
    `repos/${repository}/pulls/${prNumber}`,
    token,
    "::error::Repository read credential cannot read the target PR; Pull Requests Read is required."
  );
  const head = isJsonRecord(pull) && isJsonRecord(pull.head) ? getJsonString(pull.head, "sha") : "";
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new CliError("::error::Unable to resolve target PR head SHA.", 65);
  }
  await checkAccess(
    `repos/${repository}/actions/runs?per_page=1`,
    token,
    "::error::Repository read credential cannot read target Actions; Actions Read is required."
  );
  await checkAccess(
    `repos/${repository}/commits/${head}/status`,
    token,
    "::error::Repository read credential cannot read target commit status; Commit Statuses Read is required."
  );
  console.log(`repository=${repository}`);
  console.log(`pr_number=${prNumber}`);
  console.log(`head_sha=${head}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
