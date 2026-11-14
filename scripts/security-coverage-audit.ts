import { readFile } from "node:fs/promises";
import { GithubReader, isGithubMissing, isJsonRecord } from "./github-api.ts";
import { CliError, isMain } from "./runtime-command.ts";

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
  protected_polling_count: number;
  controller_count: number;
  unverified_count: number;
  complete: boolean;
  privacy_enforcement_verified: false;
};

export function summarizeCoverage(
  inventory: readonly InventoryRepo[],
  policy: AccessPolicy,
  bridges: ReadonlyMap<string, "present" | "absent" | "protected-polling" | "unknown">,
  controllerRepository: string
): CoverageSummary {
  if (
    !policy.organization ||
    !Array.isArray(policy.excluded_repositories) ||
    !policy.grants ||
    typeof policy.grants !== "object"
  ) {
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
    protected_polling_count: 0,
    controller_count: 0,
    unverified_count: 0,
    complete: false,
    privacy_enforcement_verified: false,
  };
  for (const repository of inventory) {
    if (
      typeof repository.full_name !== "string" ||
      !repository.full_name.startsWith(`${policy.organization}/`) ||
      names.has(repository.full_name) ||
      typeof repository.private !== "boolean" ||
      typeof repository.archived !== "boolean"
    ) {
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
    // The controller checks its own pushes and PRs without a cross-repository bridge.
    if (repository.full_name === controllerRepository) {
      summary.controller_count++;
      continue;
    }
    const status = bridges.get(repository.full_name);
    if (status === "absent") summary.missing_bridge_count++;
    else if (status === "protected-polling") summary.protected_polling_count++;
    else if (status !== "present") summary.unverified_count++;
  }
  summary.complete =
    summary.excluded_count === 0 &&
    summary.missing_policy_count === 0 &&
    summary.missing_bridge_count === 0 &&
    summary.protected_polling_count === 0 &&
    summary.unverified_count === 0;
  return summary;
}

type InventoryResponse = { total_count?: unknown; repositories?: unknown };

export async function readInstallationInventory(
  reader: Pick<GithubReader, "get">
): Promise<InventoryRepo[]> {
  const inventory: InventoryRepo[] = [];
  let total = -1;
  for (let page = 1; page <= 100; page++) {
    const response = (await reader.get(
      `installation/repositories?per_page=100&page=${page}`
    )) as InventoryResponse;
    if (
      !isJsonRecord(response) ||
      !Number.isSafeInteger(response.total_count) ||
      !Array.isArray(response.repositories)
    ) {
      throw new CliError("Security inventory page is invalid.", 65);
    }
    if (total < 0) total = response.total_count as number;
    if (response.total_count !== total || response.repositories.length > 100) {
      throw new CliError("Security inventory changed during pagination.", 77);
    }
    for (const item of response.repositories) {
      if (
        !isJsonRecord(item) ||
        typeof item.full_name !== "string" ||
        typeof item.private !== "boolean" ||
        typeof item.archived !== "boolean"
      ) {
        throw new CliError("Security inventory item is invalid.", 65);
      }
      inventory.push({
        full_name: item.full_name,
        private: item.private,
        archived: item.archived,
        disabled: item.disabled === true,
      });
    }
    if (inventory.length === total) return inventory;
    if (inventory.length > total || response.repositories.length === 0) {
      throw new CliError("Security inventory is incomplete.", 77);
    }
  }
  throw new CliError("Security inventory exceeds pagination limits.", 77);
}

/**
 * A repository without an event bridge may still be protected by an active
 * required check while periodic Intake provides the verdict. Report this as
 * polling-only, not as verified real-time security enforcement.
 */
export function hasProtectedMainGate(value: unknown, context: string): boolean {
  if (!isJsonRecord(value) || value.target !== "branch" || value.enforcement !== "active") {
    return false;
  }
  if (!Array.isArray(value.bypass_actors) || value.bypass_actors.length > 0) return false;
  if (!isJsonRecord(value.conditions) || !isJsonRecord(value.conditions.ref_name)) return false;
  const include = value.conditions.ref_name.include;
  if (!Array.isArray(include) || !include.includes("refs/heads/main")) return false;
  if (!Array.isArray(value.rules)) return false;
  return value.rules.some((rule) => {
    if (!isJsonRecord(rule) || rule.type !== "required_status_checks") return false;
    if (!isJsonRecord(rule.parameters)) return false;
    if (rule.parameters.strict_required_status_checks_policy !== true) return false;
    const checks = rule.parameters.required_status_checks;
    return (
      Array.isArray(checks) &&
      checks.some((check) => isJsonRecord(check) && check.context === context)
    );
  });
}

export function requiredMainCheck(value: unknown): string {
  if (!isJsonRecord(value) || !Array.isArray(value.rulesets)) {
    throw new CliError("Security coverage ruleset policy is malformed.", 65);
  }
  const main = value.rulesets.find((x) => isJsonRecord(x) && x.name === "Protect Main Branch");
  if (!isJsonRecord(main) || !Array.isArray(main.rules)) {
    throw new CliError("Main branch ruleset policy is unavailable.", 65);
  }
  const status = main.rules.find((x) => isJsonRecord(x) && x.type === "required_status_checks");
  if (!isJsonRecord(status) || !isJsonRecord(status.parameters)) {
    throw new CliError("Main status rule is unavailable.", 65);
  }
  const checks = status.parameters.required_status_checks;
  const context = Array.isArray(checks) && isJsonRecord(checks[0]) ? checks[0].context : null;
  if (typeof context !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(context)) {
    throw new CliError("Main branch check context is invalid.", 65);
  }
  return context;
}

export async function readProtectedPolling(
  reader: Pick<GithubReader, "get">,
  repository: string,
  context: string
): Promise<"protected-polling" | "absent" | "unknown"> {
  try {
    const list = await reader.get(
      `repos/${repository}/rulesets?includes_parents=false&per_page=100`
    );
    if (!Array.isArray(list) || list.length > 100) return "unknown";
    for (const entry of list) {
      if (!isJsonRecord(entry) || !Number.isSafeInteger(entry.id)) return "unknown";
      const detail = await reader.get(`repos/${repository}/rulesets/${entry.id}`);
      if (hasProtectedMainGate(detail, context)) return "protected-polling";
    }
    return "absent";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const token = process.env.AW_INVENTORY_TOKEN ?? "";
  const currentRepository = process.env.GITHUB_REPOSITORY ?? "";
  const ref = process.env.GITHUB_REF ?? "";
  if (!token || !currentRepository || ref !== "refs/heads/main") {
    throw new CliError(
      "Security coverage audit requires the trusted main and an App read token.",
      77
    );
  }
  const raw = JSON.parse(await readFile("policies/repository-access.json", "utf8")) as unknown;
  if (
    !isJsonRecord(raw) ||
    raw.schema_version !== 1 ||
    typeof raw.organization !== "string" ||
    currentRepository !== `${raw.organization}/action-worker` ||
    !Array.isArray(raw.excluded_repositories) ||
    raw.excluded_repositories.some((x) => typeof x !== "string") ||
    !isJsonRecord(raw.grants)
  ) {
    throw new CliError("Security coverage policy is malformed.", 65);
  }
  const policy: AccessPolicy = {
    organization: raw.organization,
    excluded_repositories: raw.excluded_repositories as string[],
    grants: raw.grants as Record<string, string[]>,
  };
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const inventory = await readInstallationInventory(reader);
  const expectedContext = requiredMainCheck(
    JSON.parse(await readFile("policies/rulesets.json", "utf8")) as unknown
  );
  const bridges = new Map<string, "present" | "absent" | "protected-polling" | "unknown">();
  for (const item of inventory) {
    if (
      item.archived ||
      item.disabled ||
      item.full_name === currentRepository ||
      policy.excluded_repositories.includes(item.full_name) ||
      !policy.grants[item.full_name]?.includes("pr")
    ) {
      continue;
    }
    try {
      await reader.get(
        `repos/${item.full_name}/contents/.github/workflows/notify-action-worker.yml`
      );
      bridges.set(item.full_name, "present");
    } catch (error) {
      if (isGithubMissing(error)) {
        bridges.set(
          item.full_name,
          await readProtectedPolling(reader, item.full_name, expectedContext)
        );
      } else {
        bridges.set(item.full_name, "unknown");
      }
    }
  }
  const result = summarizeCoverage(inventory, policy, bridges, currentRepository);
  // Only aggregate counters leave the control process. Do not print private names,
  // paths, file contents, secret names, error bodies or authorization metadata.
  console.log(JSON.stringify(result));
  if (result.excluded_count > 0 || result.protected_polling_count > 0) {
    console.warn(
      "::warning::Some repositories are excluded or depend on polling; real-time coverage is incomplete."
    );
  }
  if (
    result.missing_policy_count > 0 ||
    result.missing_bridge_count > 0 ||
    result.unverified_count > 0
  ) {
    throw new CliError("Security coverage audit found uncovered or unverified repositories.", 1);
  }
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    console.error("::error::Security coverage audit failed; details withheld.");
    process.exitCode = 1;
  });
}
