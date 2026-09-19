import {
  getGithubJson,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  runText,
} from "./runtime-command.ts";

type PullFacts = {
  baseSha: string;
  headSha: string;
  title: string;
};

export async function fetchPullFacts(repository: string, prNumber: string, token: string): Promise<PullFacts> {
  const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
  if (!isJsonRecord(pull) || pull.state !== "open") {
    throw new CliError("::error::Target PR is not open.", 65);
  }
  const base = isJsonRecord(pull.base) ? pull.base : {};
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const baseRepo = isJsonRecord(base.repo) ? getJsonString(base.repo, "full_name") : "";
  if (baseRepo !== repository) {
    throw new CliError("::error::PR base repository does not match the request repository.", 65);
  }
  const baseSha = getJsonString(base, "sha");
  const headSha = getJsonString(head, "sha");
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new CliError("::error::PR base or head SHA is invalid.", 65);
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
    await writeFacts(await fetchPullFacts(repository, prNumber, token));
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
      throw new CliError(`::error::PR head is not synchronized: initial=${initial.headSha} checkout=${actual} current=${resolved.headSha}`, 65);
    }
    console.log(`::notice::PR head changed after dispatch; governance now uses consistent facts: ${initial.headSha} → ${resolved.headSha}`);
  }
  if (!/^[0-9a-f]{40}$/.test(resolved.baseSha) || !/^[0-9a-f]{40}$/.test(resolved.headSha)) {
    throw new CliError("::error::Resolved PR base or head SHA is invalid.", 65);
  }
  await writeFacts(resolved);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
