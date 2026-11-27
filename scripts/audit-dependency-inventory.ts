import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  decodeGithubContent,
  GithubReader,
  getGithubJsonIfExists,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { type InventoryRepo, readInstallationInventory } from "./security-coverage-audit.ts";

type Reader = Pick<GithubReader, "get">;
type Branch = "main" | "dev";
type Declaration = { key: string; version: string };
type Observation = {
  branch: Branch;
  state: "scanned" | "absent" | "incomplete";
  manifests: number;
  locks: number;
  unsupported: number;
  declarations: Declaration[];
};

const shaPattern = /^[a-f0-9]{40}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const manifestPattern =
  /^(?:package\.json|pnpm-workspace\.yaml|pyproject\.toml|requirements(?:-[\w-]+)?\.(?:txt|in)|Cargo\.toml|rust-toolchain(?:\.toml)?|\.node-version|\.nvmrc|\.python-version)$/;
const lockPattern =
  /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock)$/;
const maxManifestsPerRef = 250;
const maxManifestBytes = 262144;

function declare(
  declarations: Declaration[],
  ecosystem: string,
  name: string,
  version: unknown
): boolean {
  if (
    !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) ||
    typeof version !== "string" ||
    version.length > 120 ||
    !/^(?=.*\d)[\dA-Za-z.*^~<>=!|,+ -]+$/.test(version)
  ) {
    return false;
  }
  declarations.push({ key: ecosystem + ":" + name, version });
  return true;
}

export function inspectManifest(
  path: string,
  content: string
): { declarations: Declaration[]; unsupported: number } {
  const declarations: Declaration[] = [];
  let unsupported = 0;
  const file = path.split("/").at(-1);
  function add(ecosystem: string, name: string, value: unknown): void {
    if (!declare(declarations, ecosystem, name, value)) unsupported++;
  }
  function table(ecosystem: string, value: unknown): void {
    if (value === undefined) return;
    if (!isJsonRecord(value)) {
      unsupported++;
      return;
    }
    for (const [name, spec] of Object.entries(value)) {
      add(ecosystem, name, isJsonRecord(spec) ? spec.version : spec);
    }
  }
  function python(spec: unknown): void {
    if (typeof spec !== "string") {
      unsupported++;
      return;
    }
    const match = /^([A-Za-z0-9_.-]+)(?:\[[\w.,-]+\])?\s*([<>=!~][^;#]+)?/.exec(spec.trim());
    if (!match?.[1] || !match[2]) {
      unsupported++;
      return;
    }
    add("python", match[1].toLowerCase().replace(/[-_.]+/g, "-"), match[2].trim());
  }
  if (file === "package.json") {
    const value: unknown = JSON.parse(content);
    if (!isJsonRecord(value)) throw new Error("Invalid manifest.");
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      table("npm", value[section]);
    }
    if (isJsonRecord(value.engines)) table("tool", value.engines);
    if (typeof value.packageManager === "string") {
      const match = /^(npm|pnpm|yarn|bun)@([^+]+)(?:\+.*)?$/.exec(value.packageManager);
      if (match?.[1] && match[2]) add("tool", match[1], match[2]);
      else unsupported++;
    }
  } else if (file === "pnpm-workspace.yaml") {
    const value: unknown = parseYaml(content);
    if (!isJsonRecord(value)) throw new Error("Invalid workspace.");
    table("npm", value.catalog);
    if (isJsonRecord(value.catalogs)) {
      for (const catalog of Object.values(value.catalogs)) table("npm", catalog);
    }
  } else if (file === "Cargo.toml" || file === "pyproject.toml" || file === "rust-toolchain.toml") {
    const value: unknown = parseToml(content);
    if (!isJsonRecord(value)) throw new Error("Invalid manifest.");
    if (file === "Cargo.toml") {
      for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
        table("cargo", value[section]);
      }
      if (isJsonRecord(value.workspace)) table("cargo", value.workspace.dependencies);
      if (isJsonRecord(value.package) && value.package["rust-version"] !== undefined) {
        add("tool", "rust", value.package["rust-version"]);
      }
      if (isJsonRecord(value.target)) {
        for (const target of Object.values(value.target)) {
          if (!isJsonRecord(target)) continue;
          for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
            table("cargo", target[section]);
          }
        }
      }
    } else if (file === "rust-toolchain.toml") {
      if (isJsonRecord(value.toolchain)) add("tool", "rust", value.toolchain.channel);
    } else {
      if (isJsonRecord(value.project)) {
        if (value.project["requires-python"] !== undefined) {
          add("tool", "python", value.project["requires-python"]);
        }
        if (Array.isArray(value.project.dependencies)) {
          for (const spec of value.project.dependencies) python(spec);
        }
        if (isJsonRecord(value.project["optional-dependencies"])) {
          for (const group of Object.values(value.project["optional-dependencies"])) {
            if (Array.isArray(group)) for (const spec of group) python(spec);
          }
        }
      }
      if (isJsonRecord(value["dependency-groups"])) {
        for (const group of Object.values(value["dependency-groups"])) {
          if (Array.isArray(group)) for (const spec of group) python(spec);
        }
      }
      if (isJsonRecord(value.tool) && isJsonRecord(value.tool.poetry)) {
        table("python", value.tool.poetry.dependencies);
      }
    }
  } else if (file?.startsWith("requirements")) {
    for (const line of content.split(/\r?\n/)) {
      const spec = line.trim();
      if (spec && !spec.startsWith("#")) python(spec);
    }
  } else {
    const tool =
      file === ".python-version" ? "python" : file === "rust-toolchain" ? "rust" : "node";
    add("tool", tool, content.trim().replace(/^v(?=\d)/, ""));
  }
  return { declarations, unsupported };
}

export async function inspectRef(
  reader: Reader,
  repository: string,
  branch: Branch
): Promise<Observation> {
  const result: Observation = {
    branch,
    state: "incomplete",
    manifests: 0,
    locks: 0,
    unsupported: 0,
    declarations: [],
  };
  try {
    const prefix = "repos/" + repository;
    const ref = await getGithubJsonIfExists(prefix + "/branches/" + branch, (path) =>
      reader.get(path)
    );
    if (ref === undefined) {
      if (branch === "dev") result.state = "absent";
      return result;
    }
    if (!isJsonRecord(ref) || ref.name !== branch || !isJsonRecord(ref.commit)) return result;
    const commit = getJsonString(ref.commit, "sha");
    if (!shaPattern.test(commit) || !isJsonRecord(ref.commit.commit)) return result;
    const treeSha = getJsonString(ref.commit.commit.tree, "sha");
    if (!shaPattern.test(treeSha)) return result;
    const tree = await reader.get(prefix + "/git/trees/" + treeSha + "?recursive=1");
    if (!isJsonRecord(tree) || tree.truncated !== false || !Array.isArray(tree.tree)) {
      return result;
    }
    let isIncomplete = false;
    for (const entry of tree.tree) {
      if (!isJsonRecord(entry) || typeof entry.path !== "string") {
        isIncomplete = true;
        continue;
      }
      const name = entry.path.split("/").at(-1) ?? "";
      if (lockPattern.test(name) && entry.type === "blob") result.locks++;
      if (!manifestPattern.test(name)) continue;
      result.manifests++;
      if (
        result.manifests > maxManifestsPerRef ||
        entry.type !== "blob" ||
        !["100644", "100755"].includes(getJsonString(entry, "mode")) ||
        typeof entry.size !== "number" ||
        entry.size < 0 ||
        entry.size > maxManifestBytes ||
        !shaPattern.test(getJsonString(entry, "sha"))
      ) {
        isIncomplete = true;
        continue;
      }
      try {
        const blob = await reader.get(prefix + "/git/blobs/" + getJsonString(entry, "sha"));
        const content = decodeGithubContent(blob);
        if (Buffer.byteLength(content) !== entry.size) throw new Error("Invalid blob size.");
        const parsed = inspectManifest(entry.path, content);
        result.declarations.push(...parsed.declarations);
        result.unsupported += parsed.unsupported;
      } catch {
        isIncomplete = true;
      }
    }
    const latest = await reader.get(prefix + "/branches/" + branch);
    if (!isJsonRecord(latest) || getJsonString(latest.commit, "sha") !== commit) isIncomplete = true;
    if (!isIncomplete) result.state = "scanned";
  } catch {
    // Public audit logs must never expose private API paths or upstream error bodies.
  }
  return result;
}

export async function inventoryDependencies(
  reader: Reader,
  inventory: readonly InventoryRepo[],
  organization: string,
  exclusions: readonly string[]
) {
  const seen = new Set<string>();
  const publicRefs: Array<{
    repository: string;
    branch: Branch;
    state: Observation["state"];
    manifests: number;
    locks: number;
    unsupported: number;
  }> = [];
  const groups = new Map<string, Map<string, Set<string>>>();
  let privateRepositories = 0;
  let incomplete = 0;
  let skipped = 0;
  for (const repo of inventory) {
    if (
      !repoPattern.test(repo.full_name) ||
      !repo.full_name.startsWith(organization + "/") ||
      seen.has(repo.full_name)
    ) {
      throw new CliError("Dependency inventory identity is invalid.", 65);
    }
    seen.add(repo.full_name);
  }
  for (const repo of inventory) {
    if (repo.archived || repo.disabled || exclusions.includes(repo.full_name)) {
      skipped++;
      continue;
    }
    if (repo.private) privateRepositories++;
    for (const branch of ["main", "dev"] as const) {
      const result = await inspectRef(reader, repo.full_name, branch);
      if (result.state === "incomplete") incomplete++;
      if (repo.private) continue;
      publicRefs.push({
        repository: repo.full_name,
        branch,
        state: result.state,
        manifests: result.manifests,
        locks: result.locks,
        unsupported: result.unsupported,
      });
      if (result.state !== "scanned") continue;
      for (const declaration of result.declarations) {
        const key = branch + "/" + declaration.key;
        const repositories = groups.get(key) ?? new Map<string, Set<string>>();
        const versions = repositories.get(repo.full_name) ?? new Set<string>();
        versions.add(declaration.version);
        repositories.set(repo.full_name, versions);
        groups.set(key, repositories);
      }
    }
  }
  const common = [...groups]
    .filter(([, repositories]) => repositories.size > 1)
    .map(([key, repositories]) => ({
      key,
      differentDeclarations:
        new Set([...repositories.values()].flatMap((set) => [...set])).size > 1,
      repositories: Object.fromEntries(
        [...repositories]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, versions]) => [name, [...versions].sort()])
      ),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    schema_version: 1,
    mode: "read-only-declared-versions",
    inventory_repositories: inventory.length,
    skipped,
    private_repositories: privateRepositories,
    incomplete_refs: incomplete,
    public_refs: publicRefs,
    common_public_dependencies: common,
    automatic_writes: false,
    resolved_lock_versions_scanned: false,
  };
}

async function main(): Promise<void> {
  const token = process.env.AW_INVENTORY_TOKEN;
  if (!token) throw new CliError("Read-only inventory credential is missing.", 77);
  try {
    const policy: unknown = JSON.parse(await readFile("policies/repository-access.json", "utf8"));
    if (
      !isJsonRecord(policy) ||
      typeof policy.organization !== "string" ||
      !/^[A-Za-z0-9_.-]+$/.test(policy.organization) ||
      !Array.isArray(policy.excluded_repositories) ||
      !policy.excluded_repositories.every((name) => typeof name === "string")
    ) {
      throw new Error("Invalid access policy.");
    }
    const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token, {
      attemptLimit: 2,
      timeoutMs: 10000,
    });
    const result = await inventoryDependencies(
      reader,
      await readInstallationInventory(reader),
      policy.organization,
      policy.excluded_repositories as string[]
    );
    console.log(JSON.stringify(result));
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Organization dependency inventory (read only)",
      "",
      "Installed repositories: " + result.inventory_repositories,
      "Skipped repositories: " + result.skipped,
      "Private repositories (details withheld): " + result.private_repositories,
      "Incomplete branch scans: " + result.incomplete_refs,
      "Common public dependency declarations: " + result.common_public_dependencies.length,
      "Different public declarations: " +
        result.common_public_dependencies.filter((item) => item.differentDeclarations).length,
      "",
      "See the structured log for public branch observations and version differences.",
      "Declaration differences are informational; lock resolution and compatibility are not verified.",
    ]);
  } catch {
    throw new CliError("Dependency inventory could not be verified; details withheld.", 75);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
