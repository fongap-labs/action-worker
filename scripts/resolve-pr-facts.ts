import { getGithubJson, getJsonString, isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, runText } from "./runtime-command.ts";

type PullFacts = {
  baseSha: string;
  headSha: string;
  title: string;
};

export function isManagedBranchRef(ref: string): boolean {
  return ref === "main" || ref === "dev";
}

// The existing main-only admission path cannot authorize transfers from a managed branch.
// Its commit statuses are SHA-scoped and must not overwrite protected branch evidence.
export function isGovernedPullDirection(pull: unknown, targetBranch = "main"): boolean {
  if (!isJsonRecord(pull) || !isManagedBranchRef(targetBranch)) return false;
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const headRef = getJsonString(head, "ref");
  return (
    getJsonString(base, "ref") === targetBranch && headRef !== "" && !isManagedBranchRef(headRef)
  );
}

// Governance only works on open pull requests. The advisory AI review may also run for a pull
// request that was merged while it waited, so its caller opts in.
export function legacyDevIntakeWake(pull: unknown, repository: string): boolean {
  if (!isJsonRecord(pull) || pull.state !== "open" || !isGovernedPullDirection(pull, "dev")) {
    return false;
  }
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const head = isJsonRecord(pull.head) ? pull.head : {};
  return (
    isJsonRecord(base.repo) &&
    base.repo.private === false &&
    base.repo.full_name === repository &&
    getJsonString(head.repo, "full_name") === repository &&
    /^[a-f0-9]{40}$/.test(getJsonString(head, "sha"))
  );
}

export function pullAllowsFacts(pull: unknown, isMergedAllowed: boolean): boolean {
  if (!isJsonRecord(pull)) {
    return false;
  }
  return pull.state === "open" || (isMergedAllowed && pull.merged === true);
}

/**
 * Keep the PR's reviewed base for change-scope checks. The live branch tip
 * is used only when verifying the synthetic merge checkout.
 */
export function resolvePullDiffBaseSha(base: unknown, repository: string): string {
  const baseRepo =
    isJsonRecord(base) && isJsonRecord(base.repo) ? getJsonString(base.repo, "full_name") : "";
  if (baseRepo !== repository) {
    throw new CliError("::error::PR base repository does not match the request repository.", 65);
  }
  const baseSha = getJsonString(base, "sha");
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new CliError("::error::PR diff base SHA is invalid.", 65);
  }
  return baseSha;
}

export async function fetchPullFacts(
  repository: string,
  prNumber: string,
  token: string,
  isMergedAllowed = false,
  targetBranch = "main"
): Promise<PullFacts> {
  const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
  if (!isJsonRecord(pull) || !pullAllowsFacts(pull, isMergedAllowed)) {
    throw new CliError("::error::Target PR is not open.", 65);
  }
  if (!isGovernedPullDirection(pull, targetBranch)) {
    throw new CliError(
      "::error::PR governance requires an ordinary task branch targeting main; managed branch heads require a separate authorization path.",
      65
    );
  }
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const head = isJsonRecord(pull.head) ? pull.head : {};
  if (
    targetBranch === "dev" &&
    (!isJsonRecord(base.repo) ||
      base.repo.private !== false ||
      getJsonString(head.repo, "full_name") !== repository)
  ) {
    throw new CliError("Dev PR governance requires a public same-repository PR.", 75);
  }
  const baseSha = resolvePullDiffBaseSha(base, repository);
  const headSha = getJsonString(head, "sha");
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new CliError("::error::PR head SHA is invalid.", 65);
  }
  return {
    baseSha,
    headSha,
    title: getJsonString(pull, "title").replace(/[\r\n]/g, " "),
  };
}

async function writeFacts(facts: PullFacts): Promise<void> {
  await appendLines(process.env.GITHUB_OUTPUT, [
    `base_sha=${facts.baseSha}`,
    `head_sha=${facts.headSha}`,
    `title=${facts.title}`,
  ]);
}

async function main(): Promise<void> {
  const stage = process.argv[2] ?? "";
  const repository = process.env.REPOSITORY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const token = process.env.GH_TOKEN ?? "";
  if (!repository || !prNumber || !token) {
    throw new CliError("::error::Repository, PR number, and GH_TOKEN are required.", 64);
  }
  if (stage === "route-legacy") {
    const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
    const wake = legacyDevIntakeWake(pull, repository);
    await appendLines(process.env.GITHUB_OUTPUT, [`wake_dev=${String(wake)}`]);
    return;
  }
  if (stage === "fetch") {
    await writeFacts(
      await fetchPullFacts(
        repository,
        prNumber,
        token,
        process.env.ALLOW_MERGED_PR === "true",
        process.env.AW_CI_TARGET_BRANCH ?? "main"
      )
    );
    return;
  }
  if (stage !== "resolve") {
    throw new CliError("Usage: resolve-pr-facts.ts <route-legacy|fetch|resolve>", 64);
  }
  const initial: PullFacts = {
    baseSha: process.env.INITIAL_BASE_SHA ?? "",
    headSha: process.env.INITIAL_HEAD_SHA ?? "",
    title: process.env.INITIAL_TITLE ?? "",
  };
  const actual = await runText("git", ["-C", "target", "rev-parse", "HEAD"]);
  let resolved = initial;
  const targetBranch = process.env.AW_CI_TARGET_BRANCH ?? "main";
  if (targetBranch === "dev") {
    const current = await fetchPullFacts(repository, prNumber, token, false, targetBranch);
    if (
      actual !== initial.headSha ||
      current.headSha !== initial.headSha ||
      current.baseSha !== initial.baseSha ||
      current.title !== initial.title ||
      initial.headSha !== process.env.AW_EXPECTED_PR_HEAD
    ) {
      throw new CliError("Dev PR snapshot changed after dispatch.", 75);
    }
  }
  if (actual !== initial.headSha) {
    resolved = await fetchPullFacts(repository, prNumber, token);
    if (actual !== resolved.headSha) {
      throw new CliError(
        `::error::PR head is not synchronized: initial=${initial.headSha} checkout=${actual} current=${resolved.headSha}`,
        65
      );
    }
    console.log(
      `::notice::PR head changed after dispatch; governance now uses consistent facts: ${initial.headSha} → ${resolved.headSha}`
    );
  }
  if (!/^[0-9a-f]{40}$/.test(resolved.baseSha) || !/^[0-9a-f]{40}$/.test(resolved.headSha)) {
    throw new CliError("::error::Resolved PR base or head SHA is invalid.", 65);
  }
  await writeFacts(resolved);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
