import { readFile } from "node:fs/promises";
import { inspectManifest, manifestPattern } from "./audit-dependency-inventory.ts";
import { readCurrentPrCiScope } from "./ci-scope-receipt.ts";
import {
  type DependencyPolicy,
  evaluateDeclaration,
  parseDependencyPolicy,
} from "./dependency-version-policy.ts";
import { decodeGithubContent, GithubReader, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError, isMain, runCommand } from "./runtime-command.ts";

type Branch = "main" | "dev";
type Reader = Pick<GithubReader, "get">;
type Blob = { sha: string; size?: number };
type Tree = ReadonlyMap<string, Blob>;
type ReadBlob = (blob: Blob) => Promise<string>;

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const maxManifestBytes = 262144;
const maxChangedManifests = 500;

function isManifest(path: string): boolean {
  return manifestPattern.test(path.split("/").at(-1) ?? "");
}

function drift(
  policy: DependencyPolicy,
  repository: string,
  branch: Branch,
  path: string,
  content: string,
  today: string
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of inspectManifest(path, content).declarations) {
    const status = evaluateDeclaration(policy, repository, branch, item.key, item.version, today);
    if (status !== "different" && status !== "range-review") continue;
    const identity = JSON.stringify([item.key, item.version]);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

// A changed declaration must match the central baseline or its exact active exception.
// Existing drift is retained only at the same path and with the same multiplicity.
export async function compareDependencyTrees(
  policy: DependencyPolicy,
  repository: string,
  branch: Branch,
  before: Tree,
  after: Tree,
  read: ReadBlob,
  today: string
): Promise<{ changed: number; introduced: number }> {
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter(isManifest);
  let changed = 0;
  let introduced = 0;
  for (const path of paths) {
    const old = before.get(path);
    const next = after.get(path);
    if (old?.sha === next?.sha) continue;
    changed++;
    if (changed > maxChangedManifests)
      throw new CliError("Dependency change scan is too large.", 65);
    if (!next) continue;
    const previous = old
      ? drift(policy, repository, branch, path, await read(old), today)
      : new Map<string, number>();
    const candidate = drift(policy, repository, branch, path, await read(next), today);
    for (const [identity, count] of candidate) {
      introduced += Math.max(0, count - (previous.get(identity) ?? 0));
    }
  }
  return { changed, introduced };
}

async function apiTree(reader: Reader, repository: string, sha: string): Promise<Tree> {
  const commit = await reader.get("repos/" + repository + "/git/commits/" + sha);
  const treeSha = isJsonRecord(commit) ? getJsonString(commit.tree, "sha") : "";
  if (!shaPattern.test(treeSha)) throw new CliError("Dependency commit tree is unavailable.", 75);
  const tree = await reader.get("repos/" + repository + "/git/trees/" + treeSha + "?recursive=1");
  if (!isJsonRecord(tree) || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new CliError("Dependency tree scan is incomplete.", 75);
  }
  const result = new Map<string, Blob>();
  for (const entry of tree.tree) {
    if (!isJsonRecord(entry) || typeof entry.path !== "string") {
      throw new CliError("Dependency tree entry is invalid.", 65);
    }
    if (!isManifest(entry.path)) continue;
    if (
      result.has(entry.path) ||
      entry.type !== "blob" ||
      !["100644", "100755"].includes(getJsonString(entry, "mode")) ||
      !shaPattern.test(getJsonString(entry, "sha")) ||
      typeof entry.size !== "number" ||
      entry.size < 0
    ) {
      throw new CliError("Dependency manifest is not a regular Git blob.", 65);
    }
    result.set(entry.path, { sha: getJsonString(entry, "sha"), size: entry.size });
  }
  return result;
}

async function apiBlob(reader: Reader, repository: string, blob: Blob): Promise<string> {
  if (blob.size === undefined || blob.size > maxManifestBytes) {
    throw new CliError("Dependency manifest exceeds the scan bound.", 65);
  }
  const value = await reader.get("repos/" + repository + "/git/blobs/" + blob.sha);
  const content = decodeGithubContent(value);
  if (Buffer.byteLength(content) !== blob.size) {
    throw new CliError("Dependency manifest blob size mismatch.", 65);
  }
  return content;
}

export async function checkPullDependencyDrift(
  reader: Reader,
  policy: DependencyPolicy,
  repository: string,
  branch: Branch,
  prNumber: number,
  head: string,
  today: string
): Promise<{ changed: number; introduced: number }> {
  const scope = await readCurrentPrCiScope(reader, repository, prNumber, head, branch);
  if (!scope) throw new CliError("Current dependency merge candidate is unavailable.", 75);
  const result = await compareDependencyTrees(
    policy,
    repository,
    branch,
    await apiTree(reader, repository, scope.baseSha),
    await apiTree(reader, repository, scope.mergeSha),
    (blob) => apiBlob(reader, repository, blob),
    today
  );
  const current = await readCurrentPrCiScope(reader, repository, prNumber, head, branch);
  if (!current || current.baseSha !== scope.baseSha || current.mergeSha !== scope.mergeSha) {
    throw new CliError("Dependency merge candidate changed during verification.", 75);
  }
  return result;
}

async function gitTree(root: string, sha: string): Promise<Tree> {
  const raw = await runCommand("git", ["-C", root, "ls-tree", "-r", "-z", sha]);
  const result = new Map<string, Blob>();
  for (const line of raw.toString("utf8").split("\0")) {
    if (!line) continue;
    const match = /^(\d+) (\S+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    if (!match?.[4]) throw new CliError("Invalid Git dependency tree entry.", 65);
    if (!isManifest(match[4])) continue;
    if (match[2] !== "blob" || !["100644", "100755"].includes(match[1] ?? "")) {
      throw new CliError("Dependency manifest is not a regular Git blob.", 65);
    }
    result.set(match[4], { sha: match[3] ?? "" });
  }
  return result;
}

async function gitBlob(root: string, blob: Blob): Promise<string> {
  const raw = await runCommand("git", ["-C", root, "cat-file", "blob", blob.sha], {
    maxBuffer: maxManifestBytes,
  });
  return raw.toString("utf8");
}

async function main(): Promise<void> {
  const [mode = "", repository = "", branch = "", base = "", head = "", root = ""] =
    process.argv.slice(2);
  if (
    !repositoryPattern.test(repository) ||
    (branch !== "main" && branch !== "dev") ||
    !shaPattern.test(head) ||
    (mode !== "pull" && mode !== "local")
  ) {
    throw new CliError("Invalid dependency gate identity.", 65);
  }
  const policy = parseDependencyPolicy(
    JSON.parse(await readFile("policies/dependency-versions.json", "utf8")),
    "fongap-labs"
  );
  const today = new Date().toISOString().slice(0, 10);
  let result: { changed: number; introduced: number };
  if (mode === "pull") {
    const token = process.env.AW_DEPENDENCY_GATE_READ_TOKEN;
    if (!token || !/^[1-9]\d*$/.test(base)) throw new CliError("Missing read scope.", 77);
    const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
    result = await checkPullDependencyDrift(
      reader,
      policy,
      repository,
      branch,
      Number(base),
      head,
      today
    );
  } else {
    if (!shaPattern.test(base) || !root) throw new CliError("Invalid local comparison.", 65);
    result = await compareDependencyTrees(
      policy,
      repository,
      branch,
      await gitTree(root, base),
      await gitTree(root, head),
      (blob) => gitBlob(root, blob),
      today
    );
  }
  console.log(JSON.stringify({ mode: policy.mode, ...result }));
  if (policy.mode === "ratchet" && result.introduced > 0) {
    throw new CliError("New central dependency version drift is not permitted.", 65);
  }
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    // Never disclose private paths, declarations, GitHub errors, or source content.
    console.error(
      "::error::Central dependency gate failed; check version drift or scan completeness."
    );
    process.exitCode = 1;
  });
}
