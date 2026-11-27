import { createHash, createSign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { inspectManifest } from "./audit-dependency-inventory.ts";
import { assertManualBranchAuthorization } from "./branch-transfer-approval.ts";
import { inspectNpmLock } from "./dependency-lock-integrity.ts";
import {
  type DependencyPolicy,
  evaluateDeclaration,
  parseDependencyPolicy,
} from "./dependency-version-policy.ts";
import {
  decodeGithubContent,
  GithubReader,
  getGithubJsonIfExists,
  getJsonArray,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  parseRepositoryPolicy,
  readRepositoryPolicyText,
  validateRepositoryCapability,
} from "./repository-policy.ts";
import { appendLines, CliError, isMain, runCommand } from "./runtime-command.ts";
import { type InventoryRepo, readInstallationInventory } from "./security-coverage-audit.ts";

type Reader = Pick<GithubReader, "get">;
type Writer = (path: string, body: unknown) => Promise<unknown>;
type Files = ReadonlyMap<string, string>;
type Change = { path: string; mode: "100644"; type: "blob"; content: string };
type Branch = "main" | "dev";
type Snapshot = { sha: string; tree: string; files: Map<string, string> };
type Scope = { repository: string; branch: Branch; isPrivate: boolean };

const control = "fongap-labs/action-worker";
const workflow = ".github/workflows/audit-config-scope.yml";
const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const title = "chore(dependencies): align central dependency baseline";
const prefix = "chore/dependency-baseline-";
const fileNames = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "yarn.lock",
  ".node-version",
  ".nvmrc",
  "CHANGELOG.md",
]);

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function discoverProposalTargets(
  inventory: readonly InventoryRepo[],
  grants: unknown,
  exclusions: readonly string[]
): string[] {
  const policy = parseRepositoryPolicy(grants);
  return [
    ...new Set(
      inventory
        .filter(
          (repo) =>
            repositoryPattern.test(repo.full_name) &&
            repo.full_name !== control &&
            repo.private === false &&
            !repo.archived &&
            !repo.disabled &&
            repo.default_branch === "main" &&
            !exclusions.includes(repo.full_name) &&
            policy[repo.full_name]?.includes("pr")
        )
        .map((repo) => repo.full_name)
    ),
  ].sort();
}

function serializeJson(value: unknown, original: string): string {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? "  ";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  return (
    JSON.stringify(value, null, indent).replaceAll("\n", newline) +
    (original.endsWith("\n") ? newline : "")
  );
}

function needsNode(
  policy: DependencyPolicy,
  repository: string,
  path: string,
  content: string,
  today: string,
  branch: Branch
): boolean {
  return inspectManifest(path, content).declarations.some((item) => {
    const state = evaluateDeclaration(policy, repository, branch, item.key, item.version, today);
    return item.key === "tool:node" && (state === "different" || state === "range-review");
  });
}

// Only metadata that can be updated without resolving a new dependency graph is eligible.
// All actual dependency upgrades, ambiguous lock managers and missing locks remain in the audit plan.
export function buildNodeProposal(
  policy: DependencyPolicy,
  repository: string,
  files: Files,
  today: string,
  branch: Branch = "main"
): Change[] {
  const target = policy.catalog.get("tool:node")?.version;
  if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
    throw new CliError("Central exact Node runtime is required.", 65);
  }
  const changes: Change[] = [];
  const add = (path: string, content: string) => {
    if (files.get(path) !== content) changes.push({ path, mode: "100644", type: "blob", content });
  };
  for (const path of [".node-version", ".nvmrc"]) {
    const original = files.get(path);
    if (
      original !== undefined &&
      /^v?\d+\.\d+\.\d+(?:\r?\n)?$/.test(original) &&
      needsNode(policy, repository, path, original, today, branch)
    ) {
      add(
        path,
        target + (original.endsWith("\r\n") ? "\r\n" : original.endsWith("\n") ? "\n" : "")
      );
    }
  }
  const manifest = files.get("package.json");
  const managers = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json",
    "yarn.lock",
  ].filter((path) => files.has(path));
  if (
    manifest &&
    managers.length === 1 &&
    needsNode(policy, repository, "package.json", manifest, today, branch)
  ) {
    const value: unknown = JSON.parse(manifest);
    if (
      isJsonRecord(value) &&
      isJsonRecord(value.engines) &&
      typeof value.engines.node === "string"
    ) {
      const previous = value.engines.node;
      const npmLock = files.get("package-lock.json");
      const packageManager = typeof value.packageManager === "string" ? value.packageManager : "";
      if (npmLock !== undefined && (!packageManager || packageManager.startsWith("npm@"))) {
        const lock: unknown = JSON.parse(npmLock);
        if (
          isJsonRecord(lock) &&
          (lock.lockfileVersion === 2 || lock.lockfileVersion === 3) &&
          isJsonRecord(lock.packages) &&
          isJsonRecord(lock.packages[""]) &&
          isJsonRecord(lock.packages[""].engines) &&
          lock.packages[""].engines.node === previous
        ) {
          lock.packages[""].engines.node = target;
          value.engines.node = target;
          add("package.json", serializeJson(value, manifest));
          add("package-lock.json", serializeJson(lock, npmLock));
        }
      } else if (
        managers[0] === "pnpm-lock.yaml" &&
        packageManager.startsWith("pnpm@") &&
        /(?:^|\n)importers:\s*\r?\n\s{2}\.:\s*(?:\r?\n|$)/.test(files.get("pnpm-lock.yaml") ?? "")
      ) {
        // pnpm root importer metadata has no engines field; retain the resolved lock graph.
        value.engines.node = target;
        add("package.json", serializeJson(value, manifest));
      }
    }
  }
  if (!changes.length) return [];
  const changelog = files.get("CHANGELOG.md");
  const changelogTitle = "# 更新日志";
  if (!changelog || changelog.split(/\r?\n/, 1)[0] !== changelogTitle) {
    throw new CliError("Required project change record is unavailable.", 65);
  }
  const heading = /^## \[Unreleased\]\r?$/gm;
  const matches = [...changelog.matchAll(heading)];
  if (matches.length !== 1) throw new CliError("Project change record heading is ambiguous.", 65);
  const newline = changelog.includes("\r\n") ? "\r\n" : "\n";
  const entry = "- 维护: 将项目 Node.js 运行时声明与中央版本基准同步。";
  const marker = matches[0]?.[0];
  if (!marker) {
    throw new CliError("Project change record requires manual review.", 65);
  }
  if (!changelog.includes(entry))
    add(
      "CHANGELOG.md",
      changelog.replace(
        heading,
        marker.replace(/\r$/, "") + newline + newline + entry + (newline === "\r\n" ? "\r" : "")
      )
    );
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function assertScope(reader: Reader, repository: string, isPrivate: boolean): Promise<void> {
  const meta = await reader.get("repos/" + repository);
  if (
    !isJsonRecord(meta) ||
    meta.full_name !== repository ||
    meta.private !== isPrivate ||
    meta.visibility !== (isPrivate ? "private" : "public") ||
    meta.archived !== false ||
    meta.disabled === true ||
    meta.default_branch !== "main"
  ) {
    throw new CliError("Proposal target is no longer eligible.", 77);
  }
}

async function readHead(
  reader: Reader,
  repository: string,
  branch: Branch = "main",
  isPrivate = false
): Promise<{ sha: string; tree: string }> {
  await assertScope(reader, repository, isPrivate);
  const ref = await reader.get("repos/" + repository + "/branches/" + branch);
  if (!isJsonRecord(ref) || ref.name !== branch || !isJsonRecord(ref.commit)) {
    throw new CliError("Main snapshot is unavailable.", 75);
  }
  const sha = getJsonString(ref.commit, "sha");
  const tree = isJsonRecord(ref.commit.commit) ? getJsonString(ref.commit.commit.tree, "sha") : "";
  if (!shaPattern.test(sha) || !shaPattern.test(tree)) {
    throw new CliError("Main snapshot has invalid Git object identifiers.", 75);
  }
  return { sha, tree };
}

async function readSnapshot(
  reader: Reader,
  repository: string,
  branch: Branch,
  isPrivate: boolean
): Promise<Snapshot> {
  const head = await readHead(reader, repository, branch, isPrivate);
  const tree = await reader.get("repos/" + repository + "/git/trees/" + head.tree);
  if (!isJsonRecord(tree) || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new CliError("Root tree scan is incomplete.", 75);
  }
  const files = new Map<string, string>();
  for (const item of tree.tree) {
    if (!isJsonRecord(item) || typeof item.path !== "string" || !fileNames.has(item.path)) continue;
    const sha = getJsonString(item, "sha");
    if (
      files.has(item.path) ||
      item.type !== "blob" ||
      item.mode !== "100644" ||
      !shaPattern.test(sha) ||
      typeof item.size !== "number" ||
      item.size < 0 ||
      item.size > 10 * 1024 * 1024
    ) {
      throw new CliError("Root dependency file is not eligible for a metadata proposal.", 65);
    }
    const content = decodeGithubContent(
      await reader.get("repos/" + repository + "/git/blobs/" + sha)
    );
    const actual = createHash("sha1")
      .update("blob " + Buffer.byteLength(content) + "\0")
      .update(content)
      .digest("hex");
    if (actual !== sha || Buffer.byteLength(content) !== item.size) {
      throw new CliError("Immutable dependency file did not verify.", 75);
    }
    files.set(item.path, content);
  }
  if ((await readHead(reader, repository, branch, isPrivate)).sha !== head.sha) {
    throw new CliError("Main moved during dependency proposal planning.", 75);
  }
  return { ...head, files };
}

function proposalIdentity(
  snapshot: Snapshot,
  changes: readonly Change[],
  branch: Branch = "main"
): string {
  return digest(JSON.stringify([branch, snapshot.sha, changes]));
}

export async function publishNodeProposal(
  reader: Reader,
  write: Writer,
  repository: string,
  snapshot: Snapshot,
  changes: readonly Change[],
  targetBranch: Branch = "main",
  isPrivate = false
): Promise<number | null> {
  if (changes.length === 0) return null;
  if (
    !repositoryPattern.test(repository) ||
    repository === control ||
    !shaPattern.test(snapshot.sha) ||
    !shaPattern.test(snapshot.tree) ||
    changes.some(
      (change) => !fileNames.has(change.path) || change.mode !== "100644" || change.type !== "blob"
    )
  ) {
    throw new CliError("Invalid proposal publication scope.", 77);
  }
  const repo = "repos/" + repository;
  const branch =
    prefix + targetBranch + "-" + proposalIdentity(snapshot, changes, targetBranch).slice(0, 24);
  // Do not generate a second proposal while the repository already has an open baseline PR.
  for (let page = 1; page <= 10; page++) {
    const pulls = getJsonArray(
      await reader.get(
        repo + "/pulls?state=open&base=" + targetBranch + "&per_page=100&page=" + page
      )
    );
    for (const pull of pulls) {
      if (
        isJsonRecord(pull) &&
        isJsonRecord(pull.head) &&
        getJsonString(pull.head.repo, "full_name") === repository &&
        getJsonString(pull.head, "ref").startsWith(prefix)
      ) {
        if (
          typeof pull.number !== "number" ||
          !Number.isSafeInteger(pull.number) ||
          pull.number < 1
        ) {
          throw new CliError("Existing dependency proposal identity is invalid.", 75);
        }
        return pull.number;
      }
    }
    if (pulls.length < 100) break;
    if (page === 10) throw new CliError("Open proposal scan is incomplete.", 75);
  }
  if ((await readHead(reader, repository, targetBranch, isPrivate)).sha !== snapshot.sha) {
    throw new CliError("Main moved before dependency proposal publication.", 75);
  }
  const tree = getJsonString(
    await write(repo + "/git/trees", { base_tree: snapshot.tree, tree: changes }),
    "sha"
  );
  if (!shaPattern.test(tree)) throw new CliError("GitHub did not confirm the proposal tree.", 75);
  const refPath = repo + "/git/ref/heads/" + branch;
  const existing = await getGithubJsonIfExists(refPath, (path) => reader.get(path));
  if (existing !== undefined) {
    const head = isJsonRecord(existing) ? getJsonString(existing.object, "sha") : "";
    if (!shaPattern.test(head)) throw new CliError("Existing proposal ref is invalid.", 75);
    const commit = await reader.get(repo + "/git/commits/" + head);
    if (
      !isJsonRecord(commit) ||
      getJsonString(commit.tree, "sha") !== tree ||
      !Array.isArray(commit.parents) ||
      commit.parents.length !== 1 ||
      getJsonString(commit.parents[0], "sha") !== snapshot.sha
    ) {
      throw new CliError("Existing proposal branch differs; no overwrite allowed.", 77);
    }
  } else {
    const commit = getJsonString(
      await write(repo + "/git/commits", {
        message: title + "\n\n将现有运行时及通用工程依赖与中央版本基准同步。",
        tree,
        parents: [snapshot.sha],
      }),
      "sha"
    );
    if (!shaPattern.test(commit))
      throw new CliError("GitHub did not confirm the proposal commit.", 75);
    if ((await readHead(reader, repository, targetBranch, isPrivate)).sha !== snapshot.sha) {
      throw new CliError("Main moved before dependency proposal branch creation.", 75);
    }
    await write(repo + "/git/refs", { ref: "refs/heads/" + branch, sha: commit });
  }
  if ((await readHead(reader, repository, targetBranch, isPrivate)).sha !== snapshot.sha) {
    throw new CliError("Main moved before pull request creation.", 75);
  }
  const pull = await write(repo + "/pulls", {
    title,
    head: branch,
    base: targetBranch,
    body: "同步中央运行时及已设定版本的通用工程依赖。按目标分支独立计算，兼容性由现有 CI 和合并门禁验证。",
    draft: false,
  });
  if (
    !isJsonRecord(pull) ||
    typeof pull.number !== "number" ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1
  ) {
    throw new CliError("GitHub did not confirm pull request creation.", 75);
  }
  return pull.number;
}

function token(name: string): string {
  const value = process.env[name];
  if (!value) throw new CliError("Required scoped credential is unavailable.", 77);
  return value;
}

// A private repository is handled as immutable data in the trusted control plane.
// Never send its source to a public runner checkout, artifact or package registry.
export function buildEngineeringProposal(
  policy: DependencyPolicy,
  repository: string,
  branch: Branch,
  snapshot: Snapshot,
  today: string,
  canResolve: boolean
): { changes: Change[]; lockPath: string | null } {
  const changes = new Map(
    buildNodeProposal(policy, repository, snapshot.files, today, branch).map((item) => [
      item.path,
      item,
    ])
  );
  const original = snapshot.files.get("package.json");
  const input = changes.get("package.json")?.content ?? original;
  if (!input || !original) return { changes: [...changes.values()], lockPath: null };
  const value: unknown = JSON.parse(input);
  if (!isJsonRecord(value)) throw new CliError("Invalid root manifest.", 65);
  const managers = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json",
    "yarn.lock",
  ].filter((path) => snapshot.files.has(path));
  if (managers.length !== 1) return { changes: [...changes.values()], lockPath: null };
  const lockPath = managers[0];
  if (lockPath !== "package-lock.json" && lockPath !== "pnpm-lock.yaml") {
    return { changes: [...changes.values()], lockPath: null };
  }
  const manager = typeof value.packageManager === "string" ? value.packageManager : "";
  if (
    (lockPath === "package-lock.json" && manager && !manager.startsWith("npm@")) ||
    (lockPath === "pnpm-lock.yaml" && !manager.startsWith("pnpm@"))
  ) {
    return { changes: [...changes.values()], lockPath: null };
  }
  const lockContent = changes.get(lockPath)?.content ?? snapshot.files.get(lockPath) ?? "";
  const lock: unknown =
    lockPath === "package-lock.json" ? JSON.parse(lockContent) : parseYaml(lockContent);
  if (!isJsonRecord(lock)) throw new CliError("Invalid dependency lock.", 65);
  const dependencies = value.devDependencies;
  let hasResolutionChange = false;
  if (isJsonRecord(dependencies)) {
    for (const [name, version] of Object.entries(dependencies)) {
      const key = "npm:" + name;
      const entry = policy.catalog.get(key);
      if (
        !entry ||
        entry.class !== "engineering" ||
        !entry.version ||
        !/^\d+\.\d+\.\d+$/.test(entry.version) ||
        typeof version !== "string" ||
        !/^[~^]?\d+\.\d+\.\d+$/.test(version) ||
        evaluateDeclaration(policy, repository, branch, key, version, today) === "excepted" ||
        version === entry.version
      ) {
        continue;
      }
      // A private graph can be synchronized offline only when the exact resolved version is
      // already present and its root specifier matches the original declaration.
      if (lockPath === "package-lock.json" && isJsonRecord(lock.packages)) {
        const root = lock.packages[""];
        const resolved = lock.packages["node_modules/" + name];
        if (
          isJsonRecord(root) &&
          isJsonRecord(root.devDependencies) &&
          root.devDependencies[name] === version &&
          isJsonRecord(resolved) &&
          resolved.version === entry.version &&
          typeof resolved.integrity === "string"
        ) {
          root.devDependencies[name] = entry.version;
          dependencies[name] = entry.version;
          continue;
        }
      }
      if (lockPath === "pnpm-lock.yaml" && isJsonRecord(lock.importers)) {
        const root = lock.importers["."];
        if (isJsonRecord(root) && isJsonRecord(root.devDependencies)) {
          const resolved = root.devDependencies[name];
          if (
            isJsonRecord(resolved) &&
            resolved.specifier === version &&
            resolved.version === entry.version &&
            canResolve
          ) {
            // Let pnpm serialize its own format in the sandbox.
            dependencies[name] = entry.version;
            hasResolutionChange = true;
            continue;
          }
        }
      }
      if (canResolve) {
        dependencies[name] = entry.version;
        hasResolutionChange = true;
      }
    }
  }
  const centralPnpm = policy.catalog.get("tool:pnpm")?.version;
  if (
    lockPath === "pnpm-lock.yaml" &&
    centralPnpm &&
    /^\d+\.\d+\.\d+$/.test(centralPnpm) &&
    /^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/.test(manager) &&
    manager.split("+")[0] !== "pnpm@" + centralPnpm &&
    evaluateDeclaration(
      policy,
      repository,
      branch,
      "tool:pnpm",
      manager.slice(5).split("+")[0] ?? "",
      today
    ) !== "excepted" &&
    canResolve
  ) {
    value.packageManager = "pnpm@" + centralPnpm;
    hasResolutionChange = true;
  }
  const updated = serializeJson(value, original);
  if (JSON.stringify(value) !== JSON.stringify(JSON.parse(input))) {
    changes.set("package.json", {
      path: "package.json",
      type: "blob",
      mode: "100644",
      content: updated,
    });
    if (lockPath === "package-lock.json" && !hasResolutionChange) {
      changes.set(lockPath, {
        path: lockPath,
        type: "blob",
        mode: "100644",
        content: serializeJson(lock, lockContent),
      });
    }
    if (!changes.has("CHANGELOG.md")) {
      const changelog = snapshot.files.get("CHANGELOG.md");
      const heading = /^## \[Unreleased\]\r?$/gm;
      const marker = "- 维护: 同步中央通用工程依赖及包管理器版本。";
      if (
        !changelog ||
        changelog.split(/\r?\n/, 1)[0] !== "# 更新日志" ||
        [...changelog.matchAll(heading)].length !== 1
      ) {
        throw new CliError("Project change record requires manual review.", 65);
      }
      if (!changelog.includes(marker)) {
        const newline = changelog.includes("\r\n") ? "\r\n" : "\n";
        changes.set("CHANGELOG.md", {
          path: "CHANGELOG.md",
          type: "blob",
          mode: "100644",
          content: changelog.replace(
            heading,
            "## [Unreleased]" + newline + newline + marker + (newline === "\r\n" ? "\r" : "")
          ),
        });
      }
    }
  }
  return {
    changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    lockPath: hasResolutionChange ? lockPath : null,
  };
}

function checkedLock(path: string, content: string, manifest: string): void {
  const value: unknown = JSON.parse(manifest);
  const lock: unknown = path === "package-lock.json" ? JSON.parse(content) : parseYaml(content);
  if (!isJsonRecord(value) || !isJsonRecord(lock)) throw new CliError("Invalid lock result.", 65);
  if (path === "package-lock.json" && inspectNpmLock(lock).length) {
    throw new CliError("Generated npm lock failed integrity checks.", 65);
  }
  const root =
    path === "package-lock.json"
      ? isJsonRecord(lock.packages)
        ? lock.packages[""]
        : null
      : isJsonRecord(lock.importers)
        ? lock.importers["."]
        : null;
  if (!isJsonRecord(root)) throw new CliError("Generated lock has no root importer.", 65);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const expected = value[section];
    if (!isJsonRecord(expected)) continue;
    const actual = root[section];
    if (!isJsonRecord(actual))
      throw new CliError("Generated lock is missing dependency metadata.", 65);
    for (const [name, spec] of Object.entries(expected)) {
      const entry = actual[name];
      const lockedSpec =
        path === "package-lock.json" ? entry : isJsonRecord(entry) ? entry.specifier : null;
      if (lockedSpec !== spec)
        throw new CliError("Generated lock does not match the proposed manifest.", 65);
    }
  }
}

async function resolvePublicLock(
  reader: Reader,
  scope: Scope,
  snapshot: Snapshot,
  changes: readonly Change[],
  lockPath: string,
  pnpmVersion: string
): Promise<Change> {
  if (scope.isPrivate)
    throw new CliError("Private registry resolution requires a source-native sandbox.", 77);
  const root = await mkdtemp(join(tmpdir(), "dependency-proposal-"));
  try {
    // The target is public and the job has no App or administrator credential.
    // Source code is never executed by this controller.
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      CI: "true",
      GIT_TERMINAL_PROMPT: "0",
      npm_config_ignore_scripts: "true",
      npm_config_manage_package_manager_versions: "false",
      npm_config_pm_on_fail: "error",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const run = async (command: string, args: string[]) =>
      runCommand(command, args, { cwd: root, env, timeoutMs: 240000 });
    await run("git", ["init", "--quiet"]);
    await run("git", [
      "-c",
      "protocol.file.allow=never",
      "fetch",
      "--depth=1",
      "https://github.com/" + scope.repository + ".git",
      snapshot.sha,
    ]);
    await run("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "FETCH_HEAD"]);
    const actual = (await run("git", ["rev-parse", "HEAD"])).toString("utf8").trim();
    if (actual !== snapshot.sha)
      throw new CliError("Sandbox checkout does not match the plan.", 75);
    for (const change of changes) {
      if (!fileNames.has(change.path)) throw new CliError("Unexpected proposal path.", 77);
      const expected = snapshot.files.get(change.path);
      if (
        expected === undefined ||
        (await readFile(join(root, change.path), "utf8")) !== expected
      ) {
        throw new CliError("Sandbox manifest does not match the immutable source.", 75);
      }
      await writeFile(join(root, change.path), change.content);
    }
    if (lockPath === "package-lock.json") {
      await run("npm", [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]);
    } else {
      const tools = join(root, ".git", "central-pnpm");
      await run("npm", [
        "install",
        "--global",
        "--prefix",
        tools,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry",
        "https://registry.npmjs.org",
        "pnpm@" + pnpmVersion,
      ]);
      const executable = join(tools, "bin", "pnpm");
      if ((await run(executable, ["--version"])).toString("utf8").trim() !== pnpmVersion) {
        throw new CliError("Sandbox pnpm differs from the central version.", 65);
      }
      await run(executable, [
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--config.manage-package-manager-versions=false",
      ]);
    }
    const changed = (await run("git", ["diff", "--name-only", "HEAD", "--"]))
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (changed.some((path) => path !== lockPath && !changes.some((item) => item.path === path))) {
      throw new CliError("Lock resolver modified an unauthorized path.", 77);
    }
    for (const item of changes) {
      if (
        item.path !== lockPath &&
        (await readFile(join(root, item.path), "utf8")) !== item.content
      ) {
        throw new CliError("Lock resolver modified the proposed manifest.", 77);
      }
    }
    const content = await readFile(join(root, lockPath), "utf8");
    checkedLock(lockPath, content, await readFile(join(root, "package.json"), "utf8"));
    if ((await readHead(reader, scope.repository, scope.branch, false)).sha !== snapshot.sha) {
      throw new CliError("Branch moved during lock computation.", 75);
    }
    return { path: lockPath, type: "blob", mode: "100644", content };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writerFor(writeToken: string): Writer {
  return async (path, body) => {
    const response = await runCommand("gh", ["api", "--method", "POST", path, "--input", "-"], {
      input: JSON.stringify(body),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GH_TOKEN: writeToken,
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs: 30000,
    });
    return JSON.parse(response.toString("utf8")) as unknown;
  };
}

async function getScopes(
  reader: Reader,
  inventory: readonly InventoryRepo[],
  grants: unknown,
  exclusions: readonly string[],
  isPrivate: boolean
): Promise<Scope[]> {
  const policy = parseRepositoryPolicy(grants);
  const result: Scope[] = [];
  for (const repo of inventory) {
    if (
      repo.private !== isPrivate ||
      !repositoryPattern.test(repo.full_name) ||
      repo.full_name === control ||
      repo.archived ||
      repo.disabled ||
      repo.default_branch !== "main" ||
      exclusions.includes(repo.full_name) ||
      !policy[repo.full_name]?.includes("pr")
    )
      continue;
    for (const branch of ["main", "dev"] as const) {
      const value = await getGithubJsonIfExists(
        "repos/" + repo.full_name + "/branches/" + branch,
        (path) => reader.get(path)
      );
      if (value === undefined && branch === "dev") continue;
      if (!isJsonRecord(value) || value.name !== branch)
        throw new CliError("Branch discovery is incomplete.", 75);
      result.push({ repository: repo.full_name, branch, isPrivate });
    }
  }
  return result;
}

// Mint a single-repository App token without exposing a private repository name as a workflow
// matrix, input, output, artifact name, or log entry. The App key is never passed to a child process.
async function privateWriter(
  repository: string
): Promise<{ writeToken: string; revoke: () => Promise<void> }> {
  const client = token("AW_PROPOSAL_APP_CLIENT_ID");
  const key = token("AW_PROPOSAL_APP_PRIVATE_KEY");
  const now = Math.floor(Date.now() / 1000);
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload =
    encoded({ alg: "RS256", typ: "JWT" }) +
    "." +
    encoded({ iat: now - 60, exp: now + 480, iss: client });
  const jwt = payload + "." + createSign("RSA-SHA256").update(payload).sign(key, "base64url");
  const request = async (path: string, method: string, auth: string, body?: unknown) => {
    const response = await fetch("https://api.github.com/" + path, {
      method,
      headers: {
        Authorization: "Bearer " + auth,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new CliError("Scoped private App request failed.", 75);
    return response.status === 204 ? null : ((await response.json()) as unknown);
  };
  const installation = await request("repos/" + repository + "/installation", "GET", jwt);
  if (!isJsonRecord(installation) || !Number.isSafeInteger(installation.id))
    throw new CliError("Private installation identity is invalid.", 75);
  const credentials = await request(
    "app/installations/" + installation.id + "/access_tokens",
    "POST",
    jwt,
    {
      repositories: [repository.split("/")[1]],
      permissions: { contents: "write", pull_requests: "write" },
    }
  );
  const writeToken = getJsonString(credentials, "token");
  if (!writeToken) throw new CliError("Private writer token was not issued.", 77);
  return {
    writeToken,
    revoke: async () => {
      await request("installation/token", "DELETE", writeToken);
    },
  };
}

async function authorize(repository: string, api: string): Promise<void> {
  await assertManualBranchAuthorization(
    new GithubReader(api, token("AW_PROPOSAL_ADMIN_READ_TOKEN")),
    control,
    repository,
    Number(process.env.GITHUB_RUN_ID),
    1,
    false,
    workflow
  );
}

async function main(): Promise<void> {
  const stage = process.argv[2];
  if (
    process.env.GITHUB_REPOSITORY !== control ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_RUN_ATTEMPT !== "1"
  ) {
    throw new CliError("Dependency proposal requires a fresh trusted manual dispatch.", 77);
  }
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const grants: unknown = JSON.parse(readRepositoryPolicyText());
  const access: unknown = JSON.parse(await readFile("policies/repository-access.json", "utf8"));
  if (
    !isJsonRecord(access) ||
    !Array.isArray(access.excluded_repositories) ||
    !access.excluded_repositories.every((item) => typeof item === "string")
  ) {
    throw new CliError("Repository exclusion policy is invalid.", 65);
  }
  const exclusions = access.excluded_repositories as string[];
  const policy = parseDependencyPolicy(
    JSON.parse(await readFile("policies/dependency-versions.json", "utf8")),
    "fongap-labs"
  );
  const today = new Date().toISOString().slice(0, 10);
  if (stage === "discover" || stage === "private") {
    const reader = new GithubReader(api, token("AW_INVENTORY_TOKEN"));
    const scopes = await getScopes(
      reader,
      await readInstallationInventory(reader),
      grants,
      exclusions,
      stage === "private"
    );
    if (scopes.length > 128)
      throw new CliError("Proposal batch exceeds the bounded matrix size.", 65);
    if (stage === "discover") {
      await appendLines(process.env.GITHUB_OUTPUT, [
        "count=" + scopes.length,
        "matrix=" +
          JSON.stringify({ include: scopes.map(({ repository, branch }) => ({ repository, branch })) }),
      ]);
      return;
    }
    let planned = 0;
    let published = 0;
    let failed = 0;
    let deferred = 0;
    for (const scope of scopes) {
      try {
        await authorize(scope.repository, api);
        const snapshot = await readSnapshot(reader, scope.repository, scope.branch, true);
        const result = buildEngineeringProposal(
          policy,
          scope.repository,
          scope.branch,
          snapshot,
          today,
          false
        );
        const full = buildEngineeringProposal(
          policy,
          scope.repository,
          scope.branch,
          snapshot,
          today,
          true
        );
        if (full.lockPath) deferred++;
        if (!result.changes.length) continue;
        planned++;
        if (process.env.OPERATOR_CONFIRMED !== "true") continue;
        const scoped = await privateWriter(scope.repository);
        try {
          const number = await publishNodeProposal(
            reader,
            writerFor(scoped.writeToken),
            scope.repository,
            snapshot,
            result.changes,
            scope.branch,
            true
          );
          if (number) published++;
        } finally {
          await scoped.revoke();
        }
      } catch {
        failed++;
      }
    }
    console.log(
      JSON.stringify({
        private_scopes: scopes.length,
        planned,
        published,
        deferred_registry_resolution: deferred,
        failed,
      })
    );
    if (failed) throw new CliError("Some private proposals could not be verified.", 75);
    return;
  }
  const repository = process.env.TARGET_REPOSITORY ?? "";
  const branch = process.env.TARGET_BRANCH;
  if (
    (stage !== "compute" && stage !== "prepare" && stage !== "publish") ||
    !repositoryPattern.test(repository) ||
    repository === control ||
    exclusions.includes(repository) ||
    (branch !== "main" && branch !== "dev")
  )
    throw new CliError("Dependency proposal target or stage is invalid.", 65);
  validateRepositoryCapability(repository, grants, "pr");
  const reader = new GithubReader(api, token("AW_PROPOSAL_READ_TOKEN"));
  const scope: Scope = { repository, branch, isPrivate: false };
  if (stage !== "compute") await authorize(repository, api);
  const snapshot = await readSnapshot(reader, repository, branch, false);
  const result = buildEngineeringProposal(policy, repository, branch, snapshot, today, true);
  const identity = proposalIdentity(snapshot, result.changes, branch);
  if (stage === "compute") {
    const pnpmVersion = policy.catalog.get("tool:pnpm")?.version;
    if (!pnpmVersion || !/^\d+\.\d+\.\d+$/.test(pnpmVersion))
      throw new CliError("Central pnpm version is invalid.", 65);
    const lock =
      result.lockPath && process.env.OPERATOR_CONFIRMED === "true"
        ? await resolvePublicLock(reader, scope, snapshot, result.changes, result.lockPath, pnpmVersion)
        : null;
    await assertScope(reader, repository, false);
    await writeFile(
      "dependency-proposal.json",
      JSON.stringify({ repository, branch, identity, lock })
    );
    return;
  }
  if (stage === "prepare") {
    await appendLines(process.env.GITHUB_OUTPUT, [
      "changed=" + String(result.changes.length > 0),
      "identity=" + identity,
    ]);
    console.log(
      JSON.stringify({
        repository,
        branch,
        files: result.changes.map((change) => change.path),
        lock_resolution: result.lockPath,
        automatic_writes: false,
      })
    );
    return;
  }
  if (
    process.env.OPERATOR_CONFIRMED !== "true" ||
    identity !== process.env.PROPOSAL_IDENTITY ||
    !result.changes.length
  ) {
    throw new CliError("Exact planned dependency proposal is not authorized.", 77);
  }
  const evidence: unknown = JSON.parse(await readFile("dependency-proposal.json", "utf8"));
  if (
    !isJsonRecord(evidence) ||
    evidence.repository !== repository ||
    evidence.branch !== branch ||
    evidence.identity !== identity
  ) {
    throw new CliError("Sandbox evidence does not match the trusted plan.", 75);
  }
  const changes = new Map(result.changes.map((change) => [change.path, change]));
  if (result.lockPath) {
    const lock = evidence.lock;
    if (
      !isJsonRecord(lock) ||
      lock.path !== result.lockPath ||
      typeof lock.content !== "string" ||
      Buffer.byteLength(lock.content) > 10 * 1024 * 1024
    )
      throw new CliError("Missing verified lock result.", 75);
    checkedLock(result.lockPath, lock.content, changes.get("package.json")?.content ?? "");
    changes.set(result.lockPath, {
      path: result.lockPath,
      mode: "100644",
      type: "blob",
      content: lock.content,
    });
  } else if (evidence.lock !== null) {
    throw new CliError("Unexpected lock result.", 77);
  }
  const number = await publishNodeProposal(
    reader,
    writerFor(token("AW_PROPOSAL_WRITE_TOKEN")),
    repository,
    snapshot,
    [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    branch,
    false
  );
  console.log(JSON.stringify({ repository, branch, pull_request: number }));
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    console.error("::error::Dependency proposal failed closed; details withheld.");
    process.exitCode = 1;
  });
}
