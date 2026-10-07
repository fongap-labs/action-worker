import { requireVerifiedCiEvidence } from "./ci-evidence.ts";
import { GithubReader, getJsonString } from "./github-api.ts";
import { assertTrustedMainWrite, type MainWriteProvenance } from "./main-write-guard.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

// A push-triggered task can arrive before central CI has finished on the new main commit, and the
// dispatcher marks the commit processed once it has dispatched, so wait for CI instead of failing.
const evidenceWait = { statusAttempts: 120, retryDelayMs: 10_000 };

export type TaskSourceCheck = {
  default_branch: string;
  main_write: MainWriteProvenance;
};

/**
 * The dispatch payload is only a claim. The task executor runs whatever the target commit
 * declares, including which secrets it may keep, so the commit must be the current default-branch
 * HEAD, carry verified central CI Evidence and be a trusted main write — the same rules the deploy
 * path already enforces.
 */
export async function validateTaskSource(
  reader: GithubReader,
  repository: string,
  bootstrapRef: string,
  evidenceOptions: { statusAttempts?: number; runAttempts?: number; retryDelayMs?: number } = {}
): Promise<TaskSourceCheck> {
  const ref = bootstrapRef.toLowerCase();
  if (!repositoryPattern.test(repository) || !shaPattern.test(ref)) {
    throw new CliError("::error::Task source request is invalid.", 64);
  }

  const defaultBranch = getJsonString(await reader.get(`repos/${repository}`), "default_branch");
  if (!defaultBranch) {
    throw new CliError(`::error::Task source default branch is unavailable: ${repository}.`, 65);
  }
  const headSha = getJsonString(
    await reader.get(`repos/${repository}/commits/${defaultBranch}`),
    "sha"
  );
  if (!shaPattern.test(headSha)) {
    throw new CliError("::error::Task source default HEAD is invalid.", 65);
  }
  if (headSha !== ref) {
    throw new CliError(
      `::error::Task source is stale; default HEAD moved: expected=${headSha} actual=${ref}. Waiting for the next dispatch.`,
      75
    );
  }

  await requireVerifiedCiEvidence(reader, repository, ref, { ...evidenceWait, ...evidenceOptions });
  const mainWrite = await assertTrustedMainWrite(reader, repository, ref, true);
  return { default_branch: defaultBranch, main_write: mainWrite };
}

async function main(): Promise<void> {
  const [repository = "", bootstrapRef = ""] = process.argv.slice(2);
  if (!repository || !bootstrapRef) {
    throw new CliError("Usage: validate-task-source.ts <repository> <bootstrap_ref>", 64);
  }
  const token = process.env.AW_CONTROL_TOKEN || process.env.GH_TOKEN || "";
  if (!token) {
    throw new CliError("::error::AW_CONTROL_TOKEN or GH_TOKEN is required.", 77);
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  await validateTaskSource(reader, repository, bootstrapRef);

  // The run summary of this public repository is world-readable, so name no task source here.
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Task source gate",
    "",
    "- Source: current default-branch HEAD",
    "- CI Evidence: verified Action Worker success",
    "- Main Write Guard: success",
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
