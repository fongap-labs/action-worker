import { readFile } from "node:fs/promises";
import { GithubReader, isJsonRecord, isGithubMissing } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

export type InventoryRepo = {
  full_name: string;
  private: boolean;
  archived: boolean;
  disabled?: boolean;
};

type AccessPolicy = {
  organization: string;
  excluded_repositories: string[];
  grants: Record<string, string[]>;
};

export type CoverageSummary = {
  schema_version: 1;
  scope: "installed-repositories-only";
  inventory_count: number;
  public_count: number;
  private_count: number;
  archived_count: number;
  excluded_count: number;
  missing_policy_count: number;
  missing_bridge_count: number;
  unverified_count: number;
  complete: boolean;
};

export function summarizeCoverage(
  inventory: readonly InventoryRepo[],
  policy: AccessPolicy,
  bridges: ReadonlyMap<string, "present" | "absent" | "unknown">
): CoverageSummary {
  if (!policy.organization || !Array.isArray(policy.excluded_repositories) ||
      !policy.grants || typeof policy.grants !== "object") {
    throw new CliError("Security coverage policy is invalid.", 65);
  }
  const names = new Set<string>();
  const summary: CoverageSummary = {
    schema_version: 1,
    scope: "installed-repositories-only",
    inventory_count: inventory.length,
    public_count: 0,
    private_count: 0,
    archived_count: 0,
    excluded_count: 0,
    missing_policy_count: 0,
    missing_bridge_count: 0,
    unverified_count: 0,
    complete: false,
  };
  for (const repository of inventory) {
    if (typeof repository.full_name !== "string" ||
        !repository.full_name.startsWith(`${policy.organization}/`) ||
        names.has(repository.full_name) ||
        typeof repository.private !== "boolean" || typeof repository.archived !== "boolean") {
      throw new CliError("Security inventory identity is invalid.", 65);
    }
    names.add(repository.full_name);
    if (repository.private) summary.private_count++;
    else summary.public_count++;
    if (repository.archived || repository.disabled) {
      summary.archived_count++;
      continue;
    }
    if (policy.excluded_repositories.includes(repository.full_name)) {
      summary.excluded_count++;
      continue;
    }
    const grants = policy.grants[repository.full_name];
    if (!Array.isArray(grants) || !grants.includes("pr")) {
      summary.missing_policy_count++;
      continue;
    }
    const status = bridges.get(repository.full_name);
    if (status === "absent") summary.missing_bridge_count++;
    else if (status !== "present") summary.unverified_count++;
  }
  summary.complete = summary.excluded_count === 0 && summary.missing_policy_count === 0 &&
    summary.missing_bridge_count === 0 && summary.unverified_count === 0;
  return summary;
}

type InventoryResponse = { total_count?: unknown; repositories?: unknown };
export async function readInstallationInventory(reader: Pick<GithubReader, "get">): Promise<InventoryRepo[]> {
  const inventory: InventoryRepo[] = [];
  let total = -1;
  for (let page = 1; page <= 100; page++) {
    const response = await reader.get(`installation/repositories?per_page=100&page=${page}`) as InventoryResponse;
    if (!isJsonRecord(response) || !Number.isSafeInteger(response.total_count) ||
        !Array.isArray(response.repositories)) {
      throw new CliError("Security inventory page is invalid.", 65);
    }
    if (total < 0) total = response.total_count as number;
    if (response.total_count !== total || response.repositories.length > 100) {
      throw new CliError("Security inventory changed during pagination.", 77);
    }
    for (const item of response.repositories) {
      if (!isJsonRecord(item) || typeof item.full_name !== "string" ||
          typeof item.private !== "boolean" || typeof item.archived !== "boolean") {
        throw new CliError("Security inventory item is invalid.", 65);
      }
      inventory.push({ full_name: item.full_name, private: item.private,
        archived: item.archived, disabled: item.disabled === true });
    }
    if (inventory.length === total) return inventory;
    if (inventory.length > total || response.repositories.length === 0) {
      throw new CliError("Security inventory is incomplete.", 77);
    }
  }
  throw new CliError("Security inventory exceeds pagination limits.", 77);
}

async function main(): Promise<void> {
  const token = process.env.AW_INVENTORY_TOKEN ?? "";
  const currentRepository = process.env.GITHUB_REPOSITORY ?? "";
  const ref = process.env.GITHUB_REF ?? "";
  if (!token || !currentRepository || ref !== "refs/heads/main") {
    throw new CliError("Security coverage audit requires the trusted main and an App read token.", 77);
  }
  const raw = JSON.parse(await readFile("policies/repository-access.json", "utf8")) as unknown;
  if (!isJsonRecord(raw) || raw.schema_version !== 1 ||
      typeof raw.organization !== "string" || currentRepository !== `${raw.organization}/action-worker` ||
      !Array.isArray(raw.excluded_repositories) ||
      raw.excluded_repositories.some((x) => typeof x !== "string") ||
      !isJsonRecord(raw.grants)) {
    throw new CliError("Security coverage policy is malformed.", 65);
  }
  const policy: AccessPolicy = {
    organization: raw.organization,
    excluded_repositories: raw.excluded_repositories as string[],
    grants: raw.grants as Record<string, string[]>,
  };
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const inventory = await readInstallationInventory(reader);
  const bridges = new Map<string, "present" | "absent" | "unknown">();
  for (const item of inventory) {
    if (item.archived || item.disabled || policy.excluded_repositories.includes(item.full_name) ||
        !policy.grants[item.full_name]?.includes("pr")) continue;
    try {
      await reader.get(`repos/${item.full_name}/contents/.github/workflows/notify-action-worker.yml`);
      bridges.set(item.full_name, "present");
    } catch (error) {
      bridges.set(item.full_name, isGithubMissing(error) ? "absent" : "unknown");
    }
  }
  const result = summarizeCoverage(inventory, policy, bridges);
  // Only aggregate counters leave the control process. Do not print private names,
  // paths, file contents, secret names, error bodies or authorization metadata.
  console.log(JSON.stringify(result));
  if (!result.complete) throw new CliError("Security coverage audit found uncovered or unverified repositories.", 1);
}

if (isMain(import.meta.url)) main().catch(() => {
  console.error("::error::Security coverage audit failed; details withheld.");
  process.exitCode = 1;
});
