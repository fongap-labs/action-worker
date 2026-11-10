import { getGithubJson, getJsonString, isJsonRecord, runGithubCli } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { latestAttestedStatus } from "./status-attestation.ts";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REQUIRED_GATES = ["PR Governance", "CI Evidence", "validate-merge"] as const;

// A completed advisory AI review is never part of merge admission. Only the
// current-head, cryptographically attested deterministic gates can authorize it.
export function assertReadyForAutomaticMerge(
  pull: unknown,
  statuses: unknown,
  repository: string,
  prNumber: number,
  headSha: string,
  baseSha: string,
  governanceRunUrl: string
): void {
  if (
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !SHA.test(headSha) ||
    !SHA.test(baseSha) ||
    !/^https:\/\/github\.com\/fongap-labs\/action-worker\/actions\/runs\/[1-9]\d*$/.test(
      governanceRunUrl
    )
  ) {
    throw new CliError("Invalid immutable automatic-merge identity.", 64);
  }
  if (
    !isJsonRecord(pull) ||
    pull.state !== "open" ||
    pull.merged === true ||
    pull.draft !== false ||
    pull.number !== prNumber
  ) {
    throw new CliError("Automatic merge requires the exact open, non-draft pull request.", 75);
  }
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const base = isJsonRecord(pull.base) ? pull.base : {};
  if (
    getJsonString(head, "sha") !== headSha ||
    getJsonString(base, "sha") !== baseSha ||
    getJsonString(base, "ref") !== "main"
  ) {
    throw new CliError("Pull request head or base changed since central CI; revalidate first.", 75);
  }
  for (const context of REQUIRED_GATES) {
    const status = latestAttestedStatus(statuses, { repository, sha: headSha, context });
    if (status?.state !== "success") {
      throw new CliError(
        `Automatic merge refused: ${context} lacks a current-head signed success.`,
        75
      );
    }
    if (context !== "CI Evidence" && getJsonString(status, "target_url") !== governanceRunUrl) {
      throw new CliError(
        `Automatic merge refused: ${context} belongs to another governance run.`,
        75
      );
    }
  }
}

async function main(): Promise<void> {
  const [repository = "", number = "", headSha = "", baseSha = "", governanceRunUrl = ""] =
    process.argv.slice(2);
  const readToken = process.env.AW_MERGE_READ_TOKEN ?? "";
  const writeToken = process.env.AW_MERGE_WRITE_TOKEN ?? "";
  if (process.argv.length !== 7 || !readToken || !writeToken || !/^[1-9]\d*$/.test(number)) {
    throw new CliError(
      "Usage: auto-merge-pr.ts <repo> <number> <head-sha> <base-sha> <governance-run-url> (scoped read/write tokens required)",
      64
    );
  }
  const pullPath = `repos/${repository}/pulls/${number}`;
  const pull = await getGithubJson(pullPath, readToken);
  const statuses = await getGithubJson(`repos/${repository}/commits/${headSha}/status`, readToken);
  assertReadyForAutomaticMerge(
    pull,
    statuses,
    repository,
    Number(number),
    headSha,
    baseSha,
    governanceRunUrl
  );
  // GitHub still applies protected branch rules. Matching the exact PR head
  // prevents a newer revision from being merged by this older governance run.
  await runGithubCli(
    ["pr", "merge", number, "--repo", repository, "--squash", "--match-head-commit", headSha],
    writeToken
  );
  const after = await getGithubJson(pullPath, readToken);
  if (
    !isJsonRecord(after) ||
    after.merged !== true ||
    getJsonString(after.head, "sha") !== headSha
  ) {
    throw new CliError("GitHub did not confirm the requested immutable-head merge.", 75);
  }
  console.log(`Verified CI-only squash merge: ${repository}#${number}@${headSha}.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
