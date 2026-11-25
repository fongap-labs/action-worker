import type { JsonReader } from "./ci-evidence.ts";
import { requireToken } from "./control-token.ts";
import { GithubReader, getGithubJsonIfExists, getJsonString, isJsonRecord } from "./github-api.ts";
import { readRepositoryPolicyText, repositoriesForCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;
type Result =
  | { state: "absent" | "moving" | "invalid" | "unavailable" }
  | { state: "identical" | "main-ahead" | "dev-ahead" | "diverged"; ahead: number; behind: number };

async function branchSha(reader: JsonReader, repository: string, branch: string): Promise<string> {
  const value = await getGithubJsonIfExists(`repos/${repository}/branches/${branch}`, (path) =>
    reader.get(path)
  );
  if (value === undefined) return "";
  const sha = isJsonRecord(value) ? getJsonString(value.commit, "sha") : "";
  if (!shaPattern.test(sha) || getJsonString(value, "name") !== branch) {
    throw new CliError("Managed branch response is invalid.", 65);
  }
  return sha;
}

/** Report commit ancestry, not semantic changes. Never operate on a moving compare ref. */
export async function inspectBranchDrift(reader: JsonReader, repository: string): Promise<Result> {
  const main = await branchSha(reader, repository, "main");
  if (!main) return { state: "invalid" };
  const dev = await branchSha(reader, repository, "dev");
  if (!dev) return { state: "absent" };
  let ahead = 0;
  let behind = 0;
  if (main !== dev) {
    const compare = await reader.get(`repos/${repository}/compare/${main}...${dev}?per_page=1`);
    if (
      !isJsonRecord(compare) ||
      typeof compare.ahead_by !== "number" ||
      typeof compare.behind_by !== "number" ||
      !Number.isSafeInteger(compare.ahead_by) ||
      !Number.isSafeInteger(compare.behind_by) ||
      compare.ahead_by < 0 ||
      compare.behind_by < 0 ||
      compare.ahead_by + compare.behind_by === 0 ||
      getJsonString(compare.base_commit, "sha") !== main
    ) {
      return { state: "invalid" };
    }
    ahead = compare.ahead_by;
    behind = compare.behind_by;
    const expected = ahead && behind ? "diverged" : ahead ? "ahead" : "behind";
    if (compare.status !== expected) return { state: "invalid" };
  }
  if (
    (await branchSha(reader, repository, "main")) !== main ||
    (await branchSha(reader, repository, "dev")) !== dev
  ) {
    return { state: "moving" };
  }
  const state =
    ahead && behind ? "diverged" : ahead ? "dev-ahead" : behind ? "main-ahead" : "identical";
  return { state, ahead, behind };
}

/** Never expose private repository identities, commit IDs, or comparison results in public logs. */
export async function summarizeBranchDrift(
  reader: JsonReader,
  repositories: readonly string[]
): Promise<{ lines: string[]; incomplete: number }> {
  const lines = [
    "## Managed branch drift (read-only)",
    "",
    "| Public repository | State | dev ahead | dev behind |",
    "| --- | --- | ---: | ---: |",
  ];
  let nonPublic = 0;
  let incomplete = 0;
  for (const repository of repositories) {
    let isPublic = false;
    try {
      const metadata = await reader.get(`repos/${repository}`);
      if (
        !isJsonRecord(metadata) ||
        metadata.full_name !== repository ||
        typeof metadata.private !== "boolean"
      ) {
        throw new CliError("Managed repository metadata is invalid.", 65);
      }
      isPublic = metadata.private === false;
      const result: Result =
        metadata.default_branch === "main"
          ? await inspectBranchDrift(reader, repository)
          : { state: "invalid" };
      if (["invalid", "moving", "unavailable"].includes(result.state)) incomplete += 1;
      if (isPublic) {
        lines.push(
          `| ${repository} | ${result.state} | ${"ahead" in result ? result.ahead : "—"} | ${"behind" in result ? result.behind : "—"} |`
        );
      } else {
        nonPublic += 1;
      }
    } catch {
      incomplete += 1;
      if (isPublic) lines.push(`| ${repository} | unavailable | — | — |`);
      else nonPublic += 1;
    }
  }
  lines.push(
    "",
    `Non-public or unconfirmed repositories (details withheld): ${nonPublic}.`,
    `Incomplete observations: ${incomplete}.`,
    "An absent dev is valid. Divergence is informational, never transfer authorization.",
    "Counts describe commit ancestry, not patch equivalence. No code, status or ref is written."
  );
  return { lines, incomplete };
}

async function main(): Promise<void> {
  const reader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    requireToken("control")
  );
  const repositories = repositoriesForCapability(JSON.parse(readRepositoryPolicyText()), "pr");
  const result = await summarizeBranchDrift(reader, repositories);
  await appendLines(process.env.GITHUB_STEP_SUMMARY, result.lines);
  if (result.incomplete > 0) {
    throw new CliError("Managed branch comparison was incomplete; see the redacted summary.", 75);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
