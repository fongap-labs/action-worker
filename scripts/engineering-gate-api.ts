import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChangedFile,
  filterVerifiedPluginNameOnlyChanges,
  inspectEngineeringOwnership,
  isPinnedPluginRenameCandidate,
  type OwnershipPolicy,
  PLUGIN_RENAME_BASES,
  PLUGIN_RENAME_REPOSITORY,
  parseChangedFiles,
  parseOwnershipPolicy,
} from "./central-engineering-gate.ts";
import { isDeltaCleanRootTarget, verifyDeltaCleanRootCommit } from "./delta-clean-root.ts";
import {
  resolveSourceImportBase,
  sourceImportBaselineForSource,
} from "./source-import-baselines.ts";
import { decodeGithubContent, getGithubJson, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain, runCommand, runText } from "./runtime-command.ts";

export { filterVerifiedPluginNameOnlyChanges };

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
// Verified Delta main before the exact tree-preserving root-history rewrite.
// Only the named root is eligible; all future orphan history changes fail closed.
const DELTA_VERIFIED_MAIN = "2561c645d713b425eda6926767661339ed505acf";
const DELTA_IDENTICAL_ROOT = "a199379ac6cdf3ad3bddc8c1f2874cbd1b818f25";

async function inspectPinnedPluginNameOnlyChanges(
  repository: string,
  base: string,
  head: string,
  files: ChangedFile[],
  isTargetPublic: boolean
): Promise<ChangedFile[]> {
  if (
    repository !== PLUGIN_RENAME_REPOSITORY ||
    !PLUGIN_RENAME_BASES.has(base) ||
    !isTargetPublic ||
    !files.some(isPinnedPluginRenameCandidate)
  ) {
    return files;
  }
  // Bare public Git object store: no checkout, hooks or project-controlled scripts.
  const root = mkdtempSync(join(tmpdir(), "aw-plugin-rename-"));
  try {
    await runCommand("git", ["init", "--bare", "-q", root], { timeoutMs: 30_000 });
    await runCommand(
      "git",
      [
        "-C",
        root,
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "https://github.com/" + repository + ".git",
        base,
        head,
      ],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: 180_000,
      }
    );
    for (const sha of [base, head]) {
      const actual = await runText("git", ["-C", root, "rev-parse", "--verify", sha + "^{commit}"]);
      if (actual !== sha) throw new CliError("Plugin migration Git revision mismatch.", 65);
    }
    const readAtRevision = (revision: "base" | "head", path: string): Buffer =>
      execFileSync("git", ["-C", root, "show", (revision === "base" ? base : head) + ":" + path], {
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10_000,
      });
    return filterVerifiedPluginNameOnlyChanges(files, readAtRevision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function engineeringOwnershipDiffBase(base: string): string {
  return resolveSourceImportBase(base);
}

/** Read complete immutable Git trees, not GitHub Compare's truncated 300-file list.
 * The temporary repository has no checkout, hooks, or project-controlled scripts.
 * Only public targets may use this fallback on the central control runner.
 */
export async function inventoryImmutableGitTrees(
  root: string,
  base: string,
  head: string
): Promise<ChangedFile[]> {
  for (const revision of [base, head]) {
    const actual = await runText(
      "git",
      ["-C", root, "rev-parse", "--verify", revision + "^{commit}"],
      { timeoutMs: 30_000 }
    );
    if (actual !== revision) {
      throw new CliError("Local Git inventory does not match the immutable CI revision.", 65);
    }
  }
  const changed = parseChangedFiles(
    (
      await runCommand(
        "git",
        [
          "-C",
          root,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--diff-filter=AMTD",
          "--name-status",
          "-z",
          base,
          head,
          "--",
        ],
        { timeoutMs: 120_000 }
      )
    ).toString("utf8")
  );
  // Even a workflow inherited without changes can run in a freshly imported application.
  // Inspect every active workflow against the central template policy, not only changed ones.
  const activeWorkflows = (
    await runCommand(
      "git",
      ["-C", root, "ls-tree", "-r", "--name-only", "-z", head, "--", ".github/workflows/"],
      { timeoutMs: 30_000 }
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const seen = new Set(changed.map((file) => file.path));
  for (const path of activeWorkflows) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) && !seen.has(path)) {
      changed.push({ status: "A", path });
      seen.add(path);
    }
  }
  return changed;
}

export async function fetchPublicGitInventory(
  repository: string,
  base: string,
  head: string
): Promise<ChangedFile[]> {
  if (!REPOSITORY.test(repository) || !SHA.test(base) || !SHA.test(head)) {
    throw new CliError("Invalid public Git inventory revision.", 65);
  }
  const root = mkdtempSync(join(tmpdir(), "aw-engineering-git-"));
  try {
    await runCommand("git", ["init", "--bare", "-q", root], { timeoutMs: 30_000 });
    const source = sourceImportBaselineForSource(base);
    if (source?.sourceRepository) {
      await runCommand(
        "git",
        [
          "-C", root, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules",
          "--filter=blob:none", "--depth=1", source.sourceRepository, base,
        ],
        {
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          },
          timeoutMs: 180_000,
        }
      );
      await runCommand(
        "git",
        [
          "-C", root, "fetch", "--quiet", "--no-tags", "--filter=blob:none", "--depth=1",
          "https://github.com/" + repository + ".git", head,
        ],
        {
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          },
          timeoutMs: 180_000,
        }
      );
      return await inventoryImmutableGitTrees(root, base, head);
    }
    await runCommand(
      "git",
      [
        "-C",
        root,
        "fetch",
        "--quiet",
        "--no-tags",
        "--filter=blob:none",
        "--depth=1",
        "https://github.com/" + repository + ".git",
        base,
        head,
      ],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: 180_000,
      }
    );
    return await inventoryImmutableGitTrees(root, base, head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * An imported upstream snapshot can contain workflows that were never
 * installed in the accepted product bootstrap. Deleting those inherited
 * workflows is not deleting a centrally managed workflow.
 *
 * The immutable product bootstrap tree is the authority for that distinction.
 * A missing or incomplete identity proof must fail closed.
 */
export async function filterInheritedWorkflowDeletions(
  repository: string,
  bootstrapSha: string,
  files: readonly ChangedFile[],
  policy: OwnershipPolicy,
  get: (path: string) => Promise<unknown>
): Promise<ChangedFile[]> {
  if (!files.some((file) => file.status === "D" && policy.workflow_templates[file.path])) {
    return [...files];
  }
  const prefix = "repos/" + repository + "/git/";
  const commit = await get(prefix + "commits/" + bootstrapSha);
  if (
    !isJsonRecord(commit) ||
    commit.sha !== bootstrapSha ||
    !isJsonRecord(commit.tree) ||
    typeof commit.tree.sha !== "string" ||
    !SHA.test(commit.tree.sha)
  ) {
    throw new CliError("Cannot verify accepted bootstrap workflow baseline.", 65);
  }
  const treeSha = commit.tree.sha;
  const tree = await get(prefix + "trees/" + treeSha + "?recursive=1");
  if (
    !isJsonRecord(tree) ||
    tree.sha !== treeSha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.length > 100000
  ) {
    throw new CliError("Accepted bootstrap workflow inventory is incomplete.", 65);
  }
  const bootstrapPaths = new Set<string>();
  for (const entry of tree.tree) {
    if (
      !isJsonRecord(entry) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      typeof entry.type !== "string" ||
      !["blob", "tree", "commit"].includes(entry.type) ||
      bootstrapPaths.has(entry.path)
    ) {
      throw new CliError("Accepted bootstrap workflow inventory is malformed.", 65);
    }
    bootstrapPaths.add(entry.path);
  }
  return files.filter(
    (file) =>
      file.status !== "D" || !policy.workflow_templates[file.path] || bootstrapPaths.has(file.path)
  );
}

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

/** Compare immutable Git commit/tree identities for the one exact public reset.
 * An arbitrary root has no trusted previous baseline and must fail closed.
 */
export async function verifyPinnedIdenticalRoot(
  repository: string,
  base: string,
  head: string,
  get: (path: string) => Promise<unknown>,
  isTargetPublic: boolean
): Promise<void> {
  if (
    repository !== "fongap-labs/delta" ||
    head !== DELTA_IDENTICAL_ROOT ||
    base !== head ||
    !isTargetPublic
  ) {
    throw new CliError("Identical base/head has no approved verified-root baseline.", 65);
  }
  const prefix = "repos/" + repository + "/git/commits/";
  const [root, previous] = await Promise.all([
    get(prefix + head),
    get(prefix + DELTA_VERIFIED_MAIN),
  ]);
  const treeOf = (value: unknown): string =>
    isJsonRecord(value) && isJsonRecord(value.tree) && typeof value.tree.sha === "string"
      ? value.tree.sha
      : "";
  const rootTree = treeOf(root);
  if (
    !isJsonRecord(root) ||
    root.sha !== head ||
    !Array.isArray(root.parents) ||
    root.parents.length !== 0 ||
    !isJsonRecord(previous) ||
    previous.sha !== DELTA_VERIFIED_MAIN ||
    !Array.isArray(previous.parents) ||
    previous.parents.length === 0 ||
    !SHA.test(rootTree) ||
    rootTree !== treeOf(previous)
  ) {
    throw new CliError("Pinned root migration Git tree identity is not verified.", 65);
  }
}

export async function checkGithubEngineeringOwnership(
  repository: string,
  base: string,
  head: string,
  policy: OwnershipPolicy,
  get: (path: string) => Promise<unknown>,
  readTrustedTemplate: (path: string) => string,
  fetchPublicDiff: (
    repository: string,
    base: string,
    head: string
  ) => Promise<ChangedFile[]> = fetchPublicGitInventory,
  isTargetPublic = process.env.TARGET_PRIVATE === "false"
): Promise<void> {
  if (!REPOSITORY.test(repository) || !SHA.test(base) || !SHA.test(head)) {
    throw new CliError("Invalid immutable engineering gate inputs.", 65);
  }
  if (repository === policy.control_repository) return;
  const diffBase = engineeringOwnershipDiffBase(base);
  let files: ChangedFile[];
  if (base === head) {
    if (isDeltaCleanRootTarget(repository, head) && isTargetPublic) {
      verifyDeltaCleanRootCommit(
        repository,
        head,
        await get("repos/" + repository + "/git/commits/" + head)
      );
    } else {
      await verifyPinnedIdenticalRoot(repository, base, head, get, isTargetPublic);
    }
    // A pinned root has no delta; ownership of its immutable tree is explicitly reviewed.
    files = [];
  } else if (diffBase !== base) {
    // Compare cannot represent unrelated imported histories. A pinned Git tree diff can.
    if (!isTargetPublic) {
      throw new CliError("Large Git inventory requires a verified public target.", 65);
    }
    files = await filterInheritedWorkflowDeletions(
      repository,
      base,
      await fetchPublicDiff(repository, diffBase, head),
      policy,
      get
    );
  } else {
    const result = await get("repos/" + repository + "/compare/" + base + "..." + head);
    // GitHub's compare endpoint returns base_commit, merge_base_commit and an
    // ordered commits array, NOT a head_commit field. The final comparison
    // commit is the exact requested head only when the list is complete.
    // Comparisons with >250 commits are truncated by GitHub: fail closed.
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
    if (!isJsonRecord(result) || !Array.isArray(result.files)) {
      throw new CliError("GitHub comparison did not return a file inventory.", 65);
    }
    if (result.files.length >= 300) {
      if (!isTargetPublic) {
        throw new CliError("GitHub comparison exceeds the private inventory file limit.", 65);
      }
      files = await fetchPublicDiff(repository, base, head);
    } else {
      files = parseCompareFiles(result);
    }
  }
  files = await inspectPinnedPluginNameOnlyChanges(repository, base, head, files, isTargetPublic);
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
