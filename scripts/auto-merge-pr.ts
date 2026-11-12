import { getGithubJson, getJsonString, isJsonRecord, runGithubCli } from "./github-api.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { latestAttestedStatus, originalStatusDescription } from "./status-attestation.ts";

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
    if (context === "PR Governance" || context === "validate-merge") {
      const title = getJsonString(pull, "title");
      const expected = `title-sha256=${prTitleFingerprint(title)} `;
      if (!title || !originalStatusDescription(status).startsWith(expected)) {
        throw new CliError(
          `Automatic merge refused: ${context} was not validated for the current PR title.`,
          75
        );
      }
    }
    if (context !== "CI Evidence" && getJsonString(status, "target_url") !== governanceRunUrl) {
      throw new CliError(
        `Automatic merge refused: ${context} belongs to another governance run.`,
        75
      );
    }
  }
}

export function mustRefreshBehindBranch(pull: unknown, repository: string): boolean {
  if (!isJsonRecord(pull) || pull.mergeable_state !== "behind") return false;
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const headRepo = isJsonRecord(head.repo) ? head.repo : {};
  const baseRepo = isJsonRecord(base.repo) ? base.repo : {};
  return (
    getJsonString(headRepo, "full_name") === repository &&
    getJsonString(baseRepo, "full_name") === repository
  );
}

/** Draft PRs are intentionally ineligible; this is a successful no-op, not a failed gate. */
// A second merge attempt can race with a GitHub auto-merge already approved
// for the same immutable head. A complete, exact signed-gate match is required
// before treating this as an idempotent success.
export function isApprovedCompletedMerge(
  pull: unknown,
  statuses: unknown,
  repository: string,
  prNumber: number,
  headSha: string,
  baseSha: string,
  governanceRunUrl: string
): boolean {
  if (
    !isJsonRecord(pull) ||
    pull.state !== "closed" ||
    pull.merged !== true ||
    pull.number !== prNumber ||
    getJsonString(pull, "merged_at") === "" ||
    !SHA.test(getJsonString(pull, "merge_commit_sha"))
  ) {
    return false;
  }
  // Reuse the same immutable-head, signed-PR-title, matching-run and CI checks
  // that would have authorized the attempted merge while the PR was open.
  try {
    assertReadyForAutomaticMerge(
      { ...pull, state: "open", merged: false, draft: false },
      statuses,
      repository,
      prNumber,
      headSha,
      baseSha,
      governanceRunUrl
    );
    return true;
  } catch {
    return false;
  }
}

export function isOpenDraftPull(pull: unknown, prNumber: number): boolean {
  return (
    isJsonRecord(pull) &&
    pull.state === "open" &&
    pull.merged === false &&
    pull.draft === true &&
    pull.number === prNumber
  );
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
  // The PR may have become Draft after the workflow eligibility check.
  // Respect that transition before fetching proof or attempting any write.
  if (isOpenDraftPull(pull, Number(number))) {
    console.log(`Skipped automatic merge for Draft PR: ${repository}#${number}.`);
    return;
  }
  const statuses = await getGithubJson(`repos/${repository}/commits/${headSha}/status`, readToken);
  // A competing GitHub auto-merge may have finished between the signed gate
  // publication and this job; the exact approved head still must be proven.
  if (
    isApprovedCompletedMerge(
      pull,
      statuses,
      repository,
      Number(number),
      headSha,
      baseSha,
      governanceRunUrl
    )
  ) {
    console.log(`Already merged exact CI-approved head: ${repository}#${number}@${headSha}.`);
    return;
  }
  assertReadyForAutomaticMerge(
    pull,
    statuses,
    repository,
    Number(number),
    headSha,
    baseSha,
    governanceRunUrl
  );
  // A protected main may require this PR branch to include the current base.
  // GitHub's update-branch endpoint atomically checks the old head SHA; this
  // creates a new PR head and triggers fresh CI, rather than merging stale code.
  if (mustRefreshBehindBranch(pull, repository)) {
    await runGithubCli(
      [
        "api",
        "--method",
        "PUT",
        `repos/${repository}/pulls/${number}/update-branch`,
        "-f",
        `expected_head_sha=${headSha}`,
      ],
      writeToken
    );
    console.log(
      `Refreshed behind PR branch for ${repository}#${number}; awaiting fresh CI before merge.`
    );
    return;
  }
  // GitHub still applies protected branch rules. Matching the exact PR head
  // prevents a newer revision from being merged by this older governance run.
  try {
    await runGithubCli(
      ["pr", "merge", number, "--repo", repository, "--squash", "--match-head-commit", headSha],
      writeToken
    );
  } catch (error) {
    // Do not convert an ordinary merge failure into success. Only a separately
    // verified, already-completed merge of this exact approved PR head qualifies.
    const concurrent = await getGithubJson(pullPath, readToken);
    if (
      !isApprovedCompletedMerge(
        concurrent,
        statuses,
        repository,
        Number(number),
        headSha,
        baseSha,
        governanceRunUrl
      )
    ) {
      throw error;
    }
    console.log(
      `Concurrent merge completed exact CI-approved head: ${repository}#${number}@${headSha}.`
    );
    return;
  }
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
