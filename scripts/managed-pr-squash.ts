import { getJsonString, isJsonRecord, runGithubCli } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

/** Shared write transport; callers must first verify branch-specific admission. */
export async function squashManagedPull(
  repository: string,
  prNumber: number,
  headSha: string,
  token: string,
  run: typeof runGithubCli = runGithubCli
): Promise<{ merged: true; sha: string }> {
  if (
    !repositoryPattern.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !shaPattern.test(headSha)
  ) {
    throw new CliError("Invalid immutable squash merge identity.", 64);
  }
  if (!token) throw new CliError("Scoped merge write token required.", 77);
  const result: unknown = JSON.parse(
    await run(
      [
        "api",
        "--method",
        "PUT",
        `repos/${repository}/pulls/${prNumber}/merge`,
        "-f",
        `sha=${headSha}`,
        "-f",
        "merge_method=squash",
      ],
      token
    )
  );
  const sha = getJsonString(result, "sha");
  if (!isJsonRecord(result) || result.merged !== true || !shaPattern.test(sha)) {
    throw new CliError("GitHub did not confirm the immutable-head squash merge.", 75);
  }
  return { merged: true, sha };
}
