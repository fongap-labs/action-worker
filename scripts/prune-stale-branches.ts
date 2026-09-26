import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GithubReader,
  getJsonArray,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  runText,
} from "./runtime-command.ts";
import { repositoriesForCapability } from "./repository-policy.ts";

type Decision = {
  repository: string;
  branch: string;
  result: "deleted" | "kept";
  reason: string;
};

export function isProtectedBranch(branch: string, defaultBranch: string): boolean {
  return branch === defaultBranch || branch.startsWith("legacy/");
}

function openPullHeads(value: unknown): Set<string> {
  const heads = new Set<string>();
  for (const item of getJsonArray(value)) {
    if (!isJsonRecord(item) || !isJsonRecord(item.head)) continue;
    const ref = getJsonString(item.head, "ref");
    if (ref) heads.add(ref);
  }
  return heads;
}

async function mergedTreeIsDefault(
  mirrorPath: string,
  defaultBranch: string,
  branch: string,
): Promise<boolean> {
  const defaultRef = `refs/heads/${defaultBranch}`;
  const branchRef = `refs/heads/${branch}`;
  const defaultTree = (
    await runText("git", ["-C", mirrorPath, "rev-parse", `${defaultRef}^{tree}`])
  ).trim();

  try {
    const merged = (
      await runText(
        "git",
        ["-C", mirrorPath, "merge-tree", "--write-tree", defaultRef, branchRef],
        { timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).trim().split(/\s+/)[0] ?? "";
    return merged === defaultTree;
  } catch {
    return false;
  }
}

async function cloneMirror(
  repository: string,
  token: string,
  destination: string,
): Promise<void> {
  await runText(
    "gh",
    ["repo", "clone", repository, destination, "--", "--mirror"],
    {
      env: githubEnvironment(token),
      timeoutMs: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function main(): Promise<void> {
  const token = process.env.AW_ADMIN_TOKEN ?? "";
  const rawPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  const dryRun = process.env.BRANCH_PRUNE_DRY_RUN === "true";
  if (!token || !rawPolicy) {
    throw new CliError("AW_ADMIN_TOKEN and AW_REPOSITORY_POLICY are required.", 77);
  }

  const policy = parseJson(
    rawPolicy,
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65,
  );
  const repositories = repositoriesForCapability(policy, "pr");
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const root = await mkdtemp(join(tmpdir(), "branch-prune-"));
  const decisions: Decision[] = [];

  try {
    for (const repository of repositories) {
      const repositoryValue = await reader.get(`repos/${repository}`);
      const defaultBranch = getJsonString(repositoryValue, "default_branch");
      if (!defaultBranch) {
        throw new CliError(`Default branch is unavailable: ${repository}.`, 65);
      }

      const branches = getJsonArray(
        await reader.get(`repos/${repository}/branches?per_page=100`),
      );
      const openHeads = openPullHeads(
        await reader.get(`repos/${repository}/pulls?state=open&per_page=100`),
      );
      const candidates = branches
        .filter(isJsonRecord)
        .map((item) => getJsonString(item, "name"))
        .filter(Boolean)
        .filter((name) => !isProtectedBranch(name, defaultBranch))
        .filter((name) => !openHeads.has(name));

      if (candidates.length === 0) continue;

      const mirrorPath = join(root, repository.replace("/", "__"));
      await cloneMirror(repository, token, mirrorPath);

      for (const branch of candidates) {
        const isSubsumed = await mergedTreeIsDefault(
          mirrorPath,
          defaultBranch,
          branch,
        );
        if (!isSubsumed) {
          decisions.push({
            repository,
            branch,
            result: "kept",
            reason: "merge-tree changes default branch or conflicts",
          });
          continue;
        }

        if (!dryRun) {
          await runGithubCli(
            ["api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`],
            token,
          );
        }
        decisions.push({
          repository,
          branch,
          result: dryRun ? "kept" : "deleted",
          reason: dryRun ? "safe to delete (dry run)" : "fully subsumed by default branch",
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ dry_run: dryRun, decisions }, null, 2));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
