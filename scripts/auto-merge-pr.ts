import { defaultControlRepository } from "./ci-evidence.ts";
import { getGithubJson, getJsonString, isJsonRecord, runGithubCli } from "./github-api.ts";
import { loadGateContract, requiredGateContexts } from "./governance-gate-contract.ts";
import { sleep } from "./lib/promise-delay-runtime.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { isManagedBranchRef } from "./resolve-pr-facts.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { latestAttestedStatus, originalStatusDescription } from "./status-attestation.ts";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const gateContract = loadGateContract();
const REQUIRED_GATES = requiredGateContexts(gateContract);
const governanceContext = gateContract.status_contexts.pr_governance;
const ciEvidenceContext = gateContract.status_contexts.ci_evidence;
const mergeContext = gateContract.status_contexts.merge_validation;

function isTrustedControlRunUrl(value: string, controlRepository: string): boolean {
  if (!REPOSITORY.test(controlRepository)) return false;
  const prefix = "https://github.com/" + controlRepository + "/actions/runs/";
  return value.startsWith(prefix) && /^[1-9]\d*$/.test(value.slice(prefix.length));
}

// All paths use the same cryptographically attested current-head and title checks.
// GitHub changes the observed base SHA after a PR merges; only the *open* path
// requires the original base SHA, while completed merges verify the exact head
// and completed merge identity without trusting that mutable field.
function assertSignedMergeGates(
  pull: Record<string, unknown>,
  statuses: unknown,
  repository: string,
  headSha: string,
  governanceRunUrl: string
): void {
  for (const context of REQUIRED_GATES) {
    const status = latestAttestedStatus(statuses, { repository, sha: headSha, context });
    if (status?.state !== "success") {
      throw new CliError(
        `Automatic merge refused: ${context} lacks a current-head signed success.`,
        75
      );
    }
    if (context === governanceContext || context === mergeContext) {
      const title = getJsonString(pull, "title");
      const expected = `title-sha256=${prTitleFingerprint(title)} `;
      if (!title || !originalStatusDescription(status).startsWith(expected)) {
        throw new CliError(
          `Automatic merge refused: ${context} was not validated for the current PR title.`,
          75
        );
      }
    }
    if (context !== ciEvidenceContext && getJsonString(status, "target_url") !== governanceRunUrl) {
      throw new CliError(
        `Automatic merge refused: ${context} belongs to another governance run.`,
        75
      );
    }
  }
}

// A completed advisory AI review is never part of merge admission. Only the
// current-head, cryptographically attested deterministic gates can authorize it.
export function assertReadyForAutomaticMerge(
  pull: unknown,
  statuses: unknown,
  repository: string,
  prNumber: number,
  headSha: string,
  baseSha: string,
  governanceRunUrl: string,
  controlRepository = defaultControlRepository
): void {
  if (
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !SHA.test(headSha) ||
    !SHA.test(baseSha) ||
    !isTrustedControlRunUrl(governanceRunUrl, controlRepository)
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
  if (isManagedBranchRef(getJsonString(head, "ref"))) {
    throw new CliError("Managed branch transfer requires separate human authorization.", 75);
  }
  assertSignedMergeGates(pull, statuses, repository, headSha, governanceRunUrl);
}

export function mustRefreshBehindBranch(pull: unknown, repository: string): boolean {
  if (!isJsonRecord(pull) || pull.mergeable_state !== "behind") return false;
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const headRepo = isJsonRecord(head.repo) ? head.repo : {};
  const baseRepo = isJsonRecord(base.repo) ? base.repo : {};
  return (
    !isManagedBranchRef(getJsonString(head, "ref")) &&
    getJsonString(base, "ref") === "main" &&
    getJsonString(headRepo, "full_name") === repository &&
    getJsonString(baseRepo, "full_name") === repository
  );
}

/**
 * A base advance after CI may turn a previously approved PR into "behind".
 * This authorizes only a guarded update-branch write, never a merge of old CI.
 * The resulting new head must go through CI and governance again.
 */
export function authorizeAdvancedBaseRefresh(
  pull: unknown,
  statuses: unknown,
  repository: string,
  prNumber: number,
  headSha: string,
  baseSha: string,
  governanceRunUrl: string,
  controlRepository = defaultControlRepository
): boolean {
  if (
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !SHA.test(headSha) ||
    !SHA.test(baseSha) ||
    !isTrustedControlRunUrl(governanceRunUrl, controlRepository) ||
    !isJsonRecord(pull) ||
    pull.state !== "open" ||
    pull.merged !== false ||
    pull.draft !== false ||
    pull.number !== prNumber ||
    !mustRefreshBehindBranch(pull, repository)
  ) {
    return false;
  }
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const currentBaseSha = getJsonString(base, "sha");
  if (
    getJsonString(head, "sha") !== headSha ||
    getJsonString(base, "ref") !== "main" ||
    !SHA.test(currentBaseSha) ||
    currentBaseSha === baseSha
  ) {
    return false;
  }
  // Signed current-head security/governance/CI proof is still required even
  // for this non-merge branch refresh. No stale result can authorize a merge.
  assertSignedMergeGates(pull, statuses, repository, headSha, governanceRunUrl);
  return true;
}

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
  governanceRunUrl: string,
  controlRepository = defaultControlRepository
): boolean {
  if (
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !SHA.test(headSha) ||
    !SHA.test(baseSha) ||
    !isTrustedControlRunUrl(governanceRunUrl, controlRepository) ||
    !isJsonRecord(pull) ||
    pull.state !== "closed" ||
    pull.merged !== true ||
    pull.number !== prNumber ||
    !SHA.test(getJsonString(pull, "merge_commit_sha")) ||
    getJsonString(pull.head, "sha") !== headSha ||
    isManagedBranchRef(getJsonString(pull.head, "ref")) ||
    getJsonString(pull.base, "ref") !== "main"
  ) {
    return false;
  }
  const mergedAt = Date.parse(getJsonString(pull, "merged_at"));
  if (!Number.isFinite(mergedAt)) return false;
  // A completed PR exposes today's main tip as base.sha, not necessarily the
  // original immutable base used by this run. Require the exact signed head,
  // merge identity, and all approvals *before* the merge instead.
  for (const context of REQUIRED_GATES) {
    const status = latestAttestedStatus(statuses, { repository, sha: headSha, context });
    const approvedAt = Date.parse(getJsonString(status, "created_at"));
    if (!Number.isFinite(approvedAt) || approvedAt > mergedAt) return false;
  }
  try {
    assertSignedMergeGates(pull, statuses, repository, headSha, governanceRunUrl);
    return true;
  } catch {
    return false;
  }
}

// GitHub may briefly return the pre-merge PR snapshot after an external merge
// has completed. A single immediate read can misclassify that expected race as
// an unauthorized merge and poison Main Write Guard for subsequent main writes.
// Poll only after our merge command fails; never retry the merge write itself.
// A successful read must still prove the immutable head and all signed gates.
export async function waitForApprovedCompletedMerge(
  readPull: () => Promise<unknown>,
  statuses: unknown,
  identity: {
    repository: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    governanceRunUrl: string;
    controlRepository?: string;
  },
  wait: (milliseconds: number) => Promise<void> = sleep,
  maxChecks = 5
): Promise<boolean> {
  if (!Number.isSafeInteger(maxChecks) || maxChecks < 1 || maxChecks > 5) {
    throw new CliError("Invalid bounded concurrent-merge verification attempts.", 64);
  }
  for (let check = 0; check < maxChecks; check += 1) {
    if (check > 0) await wait(1_000);
    const pull = await readPull();
    if (
      isApprovedCompletedMerge(
        pull,
        statuses,
        identity.repository,
        identity.prNumber,
        identity.headSha,
        identity.baseSha,
        identity.governanceRunUrl,
        identity.controlRepository
      )
    ) {
      return true;
    }
    // A completed but different merge is not an eventually consistent open
    // snapshot. Stop immediately rather than treating it as a timing race.
    if (isJsonRecord(pull) && pull.state === "closed") return false;
  }
  return false;
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
  const advancedBaseNeedsRefresh = authorizeAdvancedBaseRefresh(
    pull,
    statuses,
    repository,
    Number(number),
    headSha,
    baseSha,
    governanceRunUrl
  );
  // Refreshing a behind branch is not a merge, and does not reuse old-base CI.
  // When main advanced during CI, the old base no longer matches; require signed
  // evidence for the unchanged head before performing only the branch refresh.
  if (!advancedBaseNeedsRefresh) {
    assertReadyForAutomaticMerge(
      pull,
      statuses,
      repository,
      Number(number),
      headSha,
      baseSha,
      governanceRunUrl
    );
  }
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
    if (
      !(await waitForApprovedCompletedMerge(() => getGithubJson(pullPath, readToken), statuses, {
        repository,
        prNumber: Number(number),
        headSha,
        baseSha,
        governanceRunUrl,
      }))
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
