import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inspectManifest } from "./audit-dependency-inventory.ts";
import { assertManualBranchAuthorization } from "./branch-transfer-approval.ts";
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
  githubEnvironment,
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
type Snapshot = { sha: string; tree: string; files: Map<string, string> };

const control = "fongap-labs/action-worker";
const workflow = ".github/workflows/audit-config-scope.yml";
const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const title = "chore(dependencies): align node runtime baseline";
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
  today: string
): boolean {
  return inspectManifest(path, content).declarations.some((item) => {
    const state = evaluateDeclaration(policy, repository, "main", item.key, item.version, today);
    return item.key === "tool:node" && (state === "different" || state === "range-review");
  });
}

// Only metadata that can be updated without resolving a new dependency graph is eligible.
// All actual dependency upgrades, ambiguous lock managers and missing locks remain in the audit plan.
export function buildNodeProposal(
  policy: DependencyPolicy,
  repository: string,
  files: Files,
  today: string
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
      needsNode(policy, repository, path, original, today)
    ) {
      add(path, target + (original.endsWith("\r\n") ? "\r\n" : original.endsWith("\n") ? "\n" : ""));
    }
  }
  const manifest = files.get("package.json");
  const managers = ["package-lock.json", "pnpm-lock.yaml", "npm-shrinkwrap.json", "yarn.lock"].filter(
    (path) => files.has(path)
  );
  if (
    manifest &&
    managers.length === 1 &&
    needsNode(policy, repository, "package.json", manifest, today)
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
  if (!changelog || !/^# 更新日志\r?\n/.test(changelog)) {
    throw new CliError("Required project change record is unavailable.", 65);
  }
  const heading = /^## \[Unreleased\]\r?$/gm;
  const matches = [...changelog.matchAll(heading)];
  if (matches.length !== 1) throw new CliError("Project change record heading is ambiguous.", 65);
  const newline = changelog.includes("\r\n") ? "\r\n" : "\n";
  const entry = "- 维护: 将项目 Node.js 运行时声明与中央版本基准同步。";
  const marker = matches[0]?.[0];
  if (!marker || changelog.includes(entry)) {
    throw new CliError("Project change record requires manual review.", 65);
  }
  add(
    "CHANGELOG.md",
    changelog.replace(
      heading,
      marker.replace(/\r$/, "") + newline + newline + entry + (newline === "\r\n" ? "\r" : "")
    )
  );
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function assertPublicMain(reader: Reader, repository: string): Promise<void> {
  const meta = await reader.get("repos/" + repository);
  if (
    !isJsonRecord(meta) ||
    meta.full_name !== repository ||
    meta.private !== false ||
    meta.visibility !== "public" ||
    meta.archived !== false ||
    meta.disabled === true ||
    meta.default_branch !== "main"
  ) {
    throw new CliError("Public main proposal target is no longer eligible.", 77);
  }
}

async function readHead(reader: Reader, repository: string): Promise<{ sha: string; tree: string }> {
  await assertPublicMain(reader, repository);
  const ref = await reader.get("repos/" + repository + "/branches/main");
  if (!isJsonRecord(ref) || ref.name !== "main" || !isJsonRecord(ref.commit)) {
    throw new CliError("Main snapshot is unavailable.", 75);
  }
  const sha = getJsonString(ref.commit, "sha");
  const tree = isJsonRecord(ref.commit.commit) ? getJsonString(ref.commit.commit.tree, "sha") : "";
  if (!shaPattern.test(sha) || !shaPattern.test(tree)) {
    throw new CliError("Main snapshot has invalid Git object identifiers.", 75);
  }
  return { sha, tree };
}

async function readSnapshot(reader: Reader, repository: string): Promise<Snapshot> {
  const head = await readHead(reader, repository);
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
  if ((await readHead(reader, repository)).sha !== head.sha) {
    throw new CliError("Main moved during dependency proposal planning.", 75);
  }
  return { ...head, files };
}

function proposalIdentity(snapshot: Snapshot, changes: readonly Change[]): string {
  return digest(JSON.stringify([snapshot.sha, changes]));
}

export async function publishNodeProposal(
  reader: Reader,
  write: Writer,
  repository: string,
  snapshot: Snapshot,
  changes: readonly Change[]
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
  const branch = prefix + proposalIdentity(snapshot, changes).slice(0, 24);
  // Do not generate a second proposal while the repository already has an open baseline PR.
  for (let page = 1; page <= 10; page++) {
    const pulls = getJsonArray(
      await reader.get(repo + "/pulls?state=open&base=main&per_page=100&page=" + page)
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
  if ((await readHead(reader, repository)).sha !== snapshot.sha) {
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
        message: title + "\n\n将现有运行时声明与中央版本基准同步，不改变依赖解析结果。",
        tree,
        parents: [snapshot.sha],
      }),
      "sha"
    );
    if (!shaPattern.test(commit)) throw new CliError("GitHub did not confirm the proposal commit.", 75);
    if ((await readHead(reader, repository)).sha !== snapshot.sha) {
      throw new CliError("Main moved before dependency proposal branch creation.", 75);
    }
    await write(repo + "/git/refs", { ref: "refs/heads/" + branch, sha: commit });
  }
  if ((await readHead(reader, repository)).sha !== snapshot.sha) {
    throw new CliError("Main moved before pull request creation.", 75);
  }
  const pull = await write(repo + "/pulls", {
    title,
    head: branch,
    base: "main",
    body: "同步现有 Node.js 运行时声明及必要的 npm 锁文件根元数据。保留已解析依赖；兼容性由现有中央 CI 和合并门禁验证。",
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
  if (stage === "discover") {
    const inventory = await readInstallationInventory(
      new GithubReader(api, token("AW_INVENTORY_TOKEN"))
    );
    const targets = discoverProposalTargets(inventory, grants, exclusions);
    if (targets.length > 64) throw new CliError("Proposal batch exceeds the bounded matrix size.", 65);
    await appendLines(process.env.GITHUB_OUTPUT, [
      "count=" + targets.length,
      "matrix=" + JSON.stringify({ repository: targets }),
    ]);
    return;
  }
  const repository = process.env.TARGET_REPOSITORY ?? "";
  if (
    (stage !== "prepare" && stage !== "publish") ||
    !repositoryPattern.test(repository) ||
    repository === control ||
    exclusions.includes(repository)
  ) {
    throw new CliError("Dependency proposal target or stage is invalid.", 65);
  }
  validateRepositoryCapability(repository, grants, "pr");
  const reader = new GithubReader(api, token("AW_PROPOSAL_READ_TOKEN"));
  await assertPublicMain(reader, repository);
  await assertManualBranchAuthorization(
    new GithubReader(api, token("AW_PROPOSAL_ADMIN_READ_TOKEN")),
    control,
    repository,
    Number(process.env.GITHUB_RUN_ID),
    1,
    false,
    workflow
  );
  const policy = parseDependencyPolicy(
    JSON.parse(await readFile("policies/dependency-versions.json", "utf8")),
    "fongap-labs"
  );
  const snapshot = await readSnapshot(reader, repository);
  const changes = buildNodeProposal(
    policy,
    repository,
    snapshot.files,
    new Date().toISOString().slice(0, 10)
  );
  const identity = proposalIdentity(snapshot, changes);
  if (stage === "prepare") {
    await appendLines(process.env.GITHUB_OUTPUT, [
      "changed=" + String(changes.length > 0),
      "identity=" + identity,
    ]);
    console.log(
      JSON.stringify({ repository, files: changes.map((change) => change.path), automatic_writes: false })
    );
    return;
  }
  if (
    process.env.OPERATOR_CONFIRMED !== "true" ||
    identity !== process.env.PROPOSAL_IDENTITY ||
    changes.length === 0
  ) {
    throw new CliError("Exact planned dependency proposal is not authorized.", 77);
  }
  const writeToken = token("AW_PROPOSAL_WRITE_TOKEN");
  const write: Writer = async (path, body) => {
    const response = await runCommand("gh", ["api", "--method", "POST", path, "--input", "-"], {
      input: JSON.stringify(body),
      env: githubEnvironment(writeToken),
      timeoutMs: 30000,
    });
    return JSON.parse(response.toString("utf8")) as unknown;
  };
  const number = await publishNodeProposal(reader, write, repository, snapshot, changes);
  console.log(JSON.stringify({ repository, pull_request: number }));
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    console.error("::error::Dependency proposal failed closed; details withheld.");
    process.exitCode = 1;
  });
}
