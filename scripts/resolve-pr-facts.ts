import { getGithubJson, getJsonString, isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, runText } from "./runtime-command.ts";

type PullFacts = {
  baseSha: string;
  headSha: string;
  title: string;
};

// Governance only works on open pull requests. The advisory AI review may also run for a pull
// request that was merged while it waited, so its caller opts in.
export function pullAllowsFacts(pull: unknown, isMergedAllowed: boolean): boolean {
  if (!isJsonRecord(pull)) {
    return false;
  }
  return pull.state === "open" || (isMergedAllowed && pull.merged === true);
}

/**
 * The pull request payload's base.sha can lag behind the actual target branch tip.
 * Resolve the base against the branch endpoint so CI pins the same base GitHub uses
 * to construct refs/pull/<number>/merge.
 */
export function resolveCurrentBaseSha(base: unknown, branch: unknown, repository: string): string {
  const baseRepo =
    isJsonRecord(base) && isJsonRecord(base.repo) ? getJsonString(base.repo, "full_name") : "";
  if (baseRepo !== repository) {
    throw new CliError("::error::PR base repository does not match the request repository.", 65);
  }
  const baseRef = getJsonString(base, "ref");
  if (!baseRef || /[\r\n]/.test(baseRef)) {
    throw new CliError("::error::PR base branch is invalid.", 65);
  }
  const commit = isJsonRecord(branch) && isJsonRecord(branch.commit) ? branch.commit : {};
  const baseSha = getJsonString(commit, "sha");
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new CliError("::error::Target base branch HEAD SHA is invalid.", 65);
  }
  return baseSha;
}

export async function fetchPullFacts(
  repository: string,
  prNumber: string,
  token: string,
  isMergedAllowed = false
): Promise<PullFacts> {
  const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
  if (!isJsonRecord(pull) || !pullAllowsFacts(pull, isMergedAllowed)) {
    throw new CliError("::error::Target PR is not open.", 65);
  }
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const baseRef = getJsonString(base, "ref");
  if (!baseRef || /[\r\n]/.test(baseRef)) {
    throw new CliError("::error::PR base branch is invalid.", 65);
  }
  const branch = await getGithubJson(
    `repos/${repository}/branches/${encodeURIComponent(baseRef)}`,
    token
  );
  const baseSha = resolveCurrentBaseSha(base, branch, repository);
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
  if (stage === "fetch") {
    await writeFacts(
      await fetchPullFacts(repository, prNumber, token, process.env.ALLOW_MERGED_PR === "true")
    );
    return;
  }
  if (stage !== "resolve") {
    throw new CliError("Usage: resolve-pr-facts.ts <fetch|resolve>", 64);
  }
  const initial: PullFacts = {
    baseSha: process.env.INITIAL_BASE_SHA ?? "",
    headSha: process.env.INITIAL_HEAD_SHA ?? "",
    title: process.env.INITIAL_TITLE ?? "",
  };
  const actual = await runText("git", ["-C", "target", "rev-parse", "HEAD"]);
  let resolved = initial;
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
