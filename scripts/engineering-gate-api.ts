import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChangedFile,
  inspectEngineeringOwnership,
  type OwnershipPolicy,
  parseOwnershipPolicy,
} from "./central-engineering-gate.ts";
import { decodeGithubContent, getGithubJson, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { pinnedInitialImportUpstream } from "./validate-engineering-language.ts";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^fongap-labs\/[A-Za-z0-9_.-]+$/;

export function parseCompareFiles(response: unknown): ChangedFile[] {
  if (!isJsonRecord(response) || !Array.isArray(response.files)) {
    throw new CliError("GitHub comparison did not return a file inventory.", 65);
  }
  // GitHub Compare exposes at most 300 files. Never call that a complete inventory.
  if (response.files.length >= 300) {
    throw new CliError("GitHub comparison exceeds the central engineering gate file limit.", 65);
  }
  const mapped: ChangedFile[] = [];
  for (const entry of response.files) {
    if (!isJsonRecord(entry) || typeof entry.filename !== "string") {
      throw new CliError("GitHub comparison file inventory is malformed.", 65);
    }
    const status =
      entry.status === "removed"
        ? "D"
        : entry.status === "added" || entry.status === "renamed" || entry.status === "copied"
          ? "A"
          : entry.status === "modified"
            ? "M"
            : entry.status === "changed"
              ? "T"
              : null;
    if (status === null) {
      throw new CliError("GitHub comparison contains an unsupported change status.", 65);
    }
    if (entry.sha !== undefined && (typeof entry.sha !== "string" || !SHA.test(entry.sha))) {
      throw new CliError("GitHub comparison contains an invalid file blob SHA.", 65);
    }
    mapped.push({
      status,
      path: entry.filename,
      ...(entry.sha === undefined ? {} : { sha: entry.sha as string }),
    });
  }
  return mapped;
}

type GitTreeFile = { readonly sha: string; readonly mode: string; readonly type: string };

async function readVerifiedFileTree(
  repository: string,
  commitSha: string,
  get: (path: string) => Promise<unknown>
): Promise<Map<string, GitTreeFile>> {
  const prefix = "repos/" + repository + "/git/";
  const commit = await get(prefix + "commits/" + commitSha);
  if (
    !isJsonRecord(commit) ||
    commit.sha !== commitSha ||
    !isJsonRecord(commit.tree) ||
    typeof commit.tree.sha !== "string" ||
    !SHA.test(commit.tree.sha)
  ) {
    throw new CliError("Pinned engineering comparison cannot verify commit tree identity.", 65);
  }
  const treeSha = commit.tree.sha;
  const snapshot = await get(prefix + "trees/" + treeSha + "?recursive=1");
  if (
    !isJsonRecord(snapshot) ||
    snapshot.sha !== treeSha ||
    snapshot.truncated !== false ||
    !Array.isArray(snapshot.tree) ||
    snapshot.tree.length > 100000
  ) {
    throw new CliError("Pinned engineering file tree is incomplete or untrusted.", 65);
  }
  const files = new Map<string, GitTreeFile>();
  const seen = new Set<string>();
  for (const entry of snapshot.tree) {
    if (
      !isJsonRecord(entry) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").includes("..") ||
      typeof entry.sha !== "string" ||
      !SHA.test(entry.sha) ||
      typeof entry.mode !== "string" ||
      !["blob", "tree", "commit"].includes(String(entry.type)) ||
      seen.has(entry.path)
    ) {
      throw new CliError("Pinned engineering file tree has an invalid entry.", 65);
    }
    seen.add(entry.path);
    if (entry.type !== "tree") {
      files.set(entry.path, { sha: entry.sha, mode: entry.mode, type: String(entry.type) });
    }
  }
  return files;
}

export async function comparePinnedFileTrees(
  repository: string,
  upstream: string,
  head: string,
  get: (path: string) => Promise<unknown>
): Promise<ChangedFile[]> {
  if (!REPOSITORY.test(repository) || !SHA.test(upstream) || !SHA.test(head)) {
    throw new CliError("Pinned engineering comparison has invalid identities.", 65);
  }
  const [original, next] = await Promise.all([
    readVerifiedFileTree(repository, upstream, get),
    readVerifiedFileTree(repository, head, get),
  ]);
  const results: ChangedFile[] = [];
  const paths = new Set([...original.keys(), ...next.keys()]);
  for (const path of [...paths].sort()) {
    const before = original.get(path);
    const after = next.get(path);
    if (!after && before) {
      results.push({ status: "D", path });
    } else if (after && !before) {
      results.push({ status: "A", path, sha: after.sha });
    } else if (before && after) {
      if (before.sha === after.sha && before.mode === after.mode && before.type === after.type) {
        continue;
      }
      const status = before.mode !== after.mode || before.type !== after.type ? "T" : "M";
      results.push({ status, path, sha: after.sha });
    }
  }
  return results;
}

export async function checkGithubEngineeringOwnership(
  repository: string,
  base: string,
  head: string,
  policy: OwnershipPolicy,
  get: (path: string) => Promise<unknown>,
  readTrustedTemplate: (path: string) => string
): Promise<void> {
  if (!REPOSITORY.test(repository) || !SHA.test(base) || !SHA.test(head)) {
    throw new CliError("Invalid immutable engineering gate inputs.", 65);
  }
  if (repository === policy.control_repository) return;
  const pinnedUpstream = pinnedInitialImportUpstream(repository, base);
  let files: ChangedFile[];
  if (pinnedUpstream !== null) {
    files = await comparePinnedFileTrees(repository, pinnedUpstream, head, get);
  } else {
    const result = await get("repos/" + repository + "/compare/" + base + "..." + head);
    // GitHub Compare exposes only bounded commit and file inventories.
    const commits = isJsonRecord(result) && Array.isArray(result.commits) ? result.commits : [];
    const lastCommit = commits.length > 0 ? commits[commits.length - 1] : null;
    if (
      !isJsonRecord(result) ||
      !isJsonRecord(result.base_commit) ||
      result.base_commit.sha !== base ||
      !Number.isSafeInteger(result.total_commits) ||
      result.total_commits !== commits.length ||
      commits.length === 0 ||
      commits.length > 250 ||
      !isJsonRecord(lastCommit) ||
      lastCommit.sha !== head ||
      (result.head_commit !== undefined &&
        (!isJsonRecord(result.head_commit) || result.head_commit.sha !== head))
    ) {
      throw new CliError("GitHub comparison does not match the immutable CI revision.", 65);
    }
    files = parseCompareFiles(result);
  }
  // Private workflow pins are checked using GitHub's commit-bound blob identity.
  // Never fetch private workflow contents into the public control runner.
  const contents = new Map<string, string>();
  for (const entry of files) {
    if (!entry.path.startsWith(".github/workflows/")) continue;
    if (!policy.workflow_templates[entry.path] || entry.status === "D") continue;
    const data = await get(
      "repos/" +
        repository +
        "/contents/" +
        entry.path.split("/").map(encodeURIComponent).join("/") +
        "?ref=" +
        head
    );
    contents.set(entry.path, decodeGithubContent(data));
  }
  const findings = inspectEngineeringOwnership(
    policy,
    repository,
    files,
    (path) => {
      const content = contents.get(path);
      if (content === undefined)
        throw new CliError("Missing workflow contents in verified compare.", 65);
      return content;
    },
    readTrustedTemplate
  );
  if (findings.length > 0) {
    const detail =
      process.env.TARGET_PRIVATE === "true"
        ? "Details withheld for private repository."
        : findings.map((item) => item.code + ": " + item.path).join("; ");
    throw new CliError(
      "Central engineering ownership gate denied " + findings.length + " change(s). " + detail,
      65
    );
  }
  console.log("Central engineering ownership gate passed (" + files.length + " files).");
}

async function main(): Promise<void> {
  const [repository = "", base = "", head = ""] = process.argv.slice(2);
  const controlRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const policy = parseOwnershipPolicy(
    JSON.parse(
      readFileSync(join(controlRoot, "policies", "engineering-ownership.json"), "utf8")
    ) as unknown
  );
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!token) throw new CliError("Central engineering ownership gate read token is missing.", 77);
  try {
    await checkGithubEngineeringOwnership(
      repository,
      base,
      head,
      policy,
      (path) => getGithubJson(path, token),
      (path) => readFileSync(join(controlRoot, path), "utf8")
    );
  } catch (error) {
    if (process.env.TARGET_PRIVATE === "true") {
      throw new CliError(
        "Central engineering ownership gate failed; details withheld for private repository.",
        65
      );
    }
    throw error;
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
