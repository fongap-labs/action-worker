import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { handleError, isMain } from "./runtime-command.ts";

export type CiRangeInputs = {
  event: string;
  prBase: string;
  prHead: string;
  pushBefore: string;
  sha: string;
};

export type CiRange = { base: string; head: string };

type GitRead = (args: string[]) => string;

function readGit(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function rootCommit(sha: string, git: GitRead): string {
  return git(["rev-list", "--max-parents=0", sha]).split(/\r?\n/).at(-1) ?? "";
}

/** Exactly matches the previous Naming/Security workflow ranges for each event. */
export function resolveCiChangeRange(input: CiRangeInputs, git: GitRead = readGit): CiRange {
  if (input.event === "pull_request") {
    return { base: input.prBase, head: input.prHead };
  }
  if (input.event === "push") {
    return {
      base: input.pushBefore === "0".repeat(40) ? rootCommit(input.sha, git) : input.pushBefore,
      head: input.sha,
    };
  }
  let base: string;
  try {
    base = git(["rev-parse", `${input.sha}^`]);
  } catch {
    base = rootCommit(input.sha, git);
  }
  return { base, head: input.sha };
}

function main(): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required for CI range resolution.");
  const range = resolveCiChangeRange({
    event: process.env.GITHUB_EVENT_NAME ?? "",
    prBase: process.env.PR_BASE_SHA ?? "",
    prHead: process.env.PR_HEAD_SHA ?? "",
    pushBefore: process.env.PUSH_BEFORE_SHA ?? "",
    sha: process.env.GITHUB_SHA ?? "",
  });
  appendFileSync(outputPath, `base=${range.base}\nhead=${range.head}\n`, "utf8");
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    handleError(error);
  }
}
