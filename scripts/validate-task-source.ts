import { assertOrdinaryDevelopmentTarget, readBranchPolicy } from "./branch-publication-policy.ts";
import {
  centralCiWait,
  defaultControlRepository,
  requireVerifiedCiEvidence,
} from "./ci-evidence.ts";
import { assertTrustedDevWrite } from "./dev-write-guard.ts";
import { GithubReader, getJsonString, isJsonRecord } from "./github-api.ts";
import { assertTrustedMainWrite, type MainWriteProvenance } from "./main-write-guard.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

export type TaskSourceCheck =
  | { default_branch: string; target_branch: "main"; main_write: MainWriteProvenance }
  | { default_branch: string; target_branch: "dev" };

/**
 * Main tasks require current CI and trusted main writes. Development tasks require current
 * protected dev provenance and must enter the separate credential-free execution path.
 */
export async function validateTaskSource(
  reader: GithubReader,
  repository: string,
  bootstrapRef: string,
  evidenceOptions: { statusAttempts?: number; runAttempts?: number; retryDelayMs?: number } = {},
  targetBranch = "main",
  isOrdinaryDevelopment = false
): Promise<TaskSourceCheck> {
  const ref = bootstrapRef.toLowerCase();
  if (!repositoryPattern.test(repository) || !shaPattern.test(ref)) {
    throw new CliError("::error::Task source request is invalid.", 64);
  }

  if (targetBranch !== "main" && (targetBranch !== "dev" || !isOrdinaryDevelopment)) {
    throw new CliError("::error::Task target branch is not admitted by the current control.", 77);
  }
  const metadata = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(metadata, "default_branch");
  if (defaultBranch !== "main") {
    throw new CliError("::error::Task source default branch does not match the locked target.", 65);
  }
  if (targetBranch === "dev" && (!isJsonRecord(metadata) || metadata.private !== false)) {
    throw new CliError("Development task requires public isolated execution.", 77);
  }
  if (isOrdinaryDevelopment) {
    await assertOrdinaryDevelopmentTarget(
      (path) => reader.get(path),
      repository,
      targetBranch,
      readBranchPolicy()
    );
  }
  const headSha = getJsonString(
    await reader.get(`repos/${repository}/commits/${targetBranch}`),
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

  if (targetBranch === "dev") {
    await assertTrustedDevWrite(reader, repository, ref, defaultControlRepository);
    return { default_branch: defaultBranch, target_branch: targetBranch };
  }

  // A push-triggered task can arrive before central CI has finished on the new main commit, and the
  // dispatcher marks the commit processed once it has dispatched, so wait for CI instead of failing.
  await requireVerifiedCiEvidence(reader, repository, ref, {
    ...centralCiWait,
    ...evidenceOptions,
  });
  const mainWrite = await assertTrustedMainWrite(reader, repository, ref, true);
  return { default_branch: defaultBranch, target_branch: targetBranch, main_write: mainWrite };
}

async function main(): Promise<void> {
  const [repository = "", bootstrapRef = "", targetBranch = "main"] = process.argv.slice(2);
  if (!repository || !bootstrapRef) {
    throw new CliError(
      "Usage: validate-task-source.ts <repository> <bootstrap_ref> [target_branch]",
      64
    );
  }
  const token = process.env.AW_CONTROL_TOKEN || process.env.GH_TOKEN || "";
  if (!token) {
    throw new CliError("::error::AW_CONTROL_TOKEN or GH_TOKEN is required.", 77);
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const isOrdinaryDevelopment =
    process.env.AGENT_DOMAIN === "coding" &&
    (process.env.OPERATION === "task" || process.env.OPERATION === "scheduled");
  const check = await validateTaskSource(
    reader,
    repository,
    bootstrapRef,
    {},
    targetBranch,
    isOrdinaryDevelopment
  );

  // The run summary of this public repository is world-readable, so name no task source here.
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Task source gate",
    "",
    `- Source: current locked ${check.target_branch} HEAD`,
    ...(check.target_branch === "dev"
      ? ["- Dev Write Guard: verified"]
      : ["- CI Evidence: verified Action Worker success", "- Main Write Guard: success"]),
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
