import { getGithubJson, getJsonString, isJsonRecord } from "./github-api.ts";
import { sleep } from "./lib/promise-delay-runtime.ts";
import { isManagedBranchRef, isReservedMergeSourceRef } from "./resolve-pr-facts.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type MergePreflightResult = "ready" | "retry" | "refresh";

export function classifyPrMergeability(
  pull: unknown,
  repository: string,
  prNumber: number,
  headSha: string,
  baseSha: string,
  targetBranch = "main"
): MergePreflightResult {
  if (
    !isManagedBranchRef(targetBranch) ||
    !repositoryPattern.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !shaPattern.test(headSha) ||
    !shaPattern.test(baseSha)
  ) {
    throw new CliError("::error::Invalid PR mergeability preflight identity.", 64);
  }
  if (!isJsonRecord(pull) || pull.state !== "open" || pull.number !== prNumber) {
    throw new CliError("::error::PR closed or replaced before mergeability preflight.", 75);
  }
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const base = isJsonRecord(pull.base) ? pull.base : {};
  if (
    getJsonString(head, "sha") !== headSha ||
    getJsonString(base, "sha") !== baseSha ||
    getJsonString(base, "ref") !== targetBranch
  ) {
    throw new CliError("::error::PR head or main changed before CI; resolve the new snapshot.", 75);
  }
  if (isReservedMergeSourceRef(getJsonString(head, "ref"))) {
    throw new CliError(
      "::error::Managed branch transfer requires separate human authorization.",
      75
    );
  }
  if (pull.draft === true) return "ready";
  if (pull.mergeable === false || pull.mergeable_state === "dirty") {
    throw new CliError(
      "::error::PR has merge conflicts with main. Resolve conflicts before expensive CI.",
      75
    );
  }
  if (pull.mergeable !== true || pull.mergeable_state === "unknown" || !pull.mergeable_state) {
    return "retry";
  }
  if (pull.mergeable_state === "behind") {
    if (targetBranch === "dev") {
      throw new CliError("Dev PR must be refreshed within its own task branch.", 75);
    }
    const headRepository = getJsonString(head.repo, "full_name");
    const baseRepository = getJsonString(base.repo, "full_name");
    if (headRepository !== repository || baseRepository !== repository) {
      throw new CliError(
        "::error::PR branch is behind main but cannot be refreshed by the central same-repo updater.",
        75
      );
    }
    return "refresh";
  }
  return "ready";
}

async function main(): Promise<void> {
  const [repository = "", number = "", headSha = "", baseSha = ""] = process.argv.slice(2);
  const token = process.env.GH_TOKEN ?? "";
  const prNumber = Number(number);
  if (process.argv.length !== 6 || !token || !/^[1-9]\d*$/.test(number)) {
    throw new CliError("Usage: pr-merge-preflight.ts <repo> <number> <head-sha> <base-sha>", 64);
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const pull = await getGithubJson("repos/" + repository + "/pulls/" + prNumber, token);
    const outcome = classifyPrMergeability(
      pull,
      repository,
      prNumber,
      headSha,
      baseSha,
      process.env.AW_PR_TARGET_BRANCH ?? "main"
    );
    if (outcome === "ready") {
      console.log("PR mergeability preflight passed for the current head and base.");
      return;
    }
    if (outcome === "refresh") {
      await appendLines(process.env.GITHUB_OUTPUT, ["needs_refresh=true"]);
      console.log("PR branch is behind main; refresh before starting expensive CI.");
      return;
    }
    if (attempt < 5) await sleep(2_000);
  }
  throw new CliError(
    "::error::GitHub mergeability remains unknown; expensive CI must not proceed.",
    75
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
