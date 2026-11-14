import { readFile } from "node:fs/promises";
import { GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

// This script checks metadata coverage only; it does NOT certify that a repository's
// required status checks or source-code scanning are functioning.
export type PrivacyCoverageSummary = {
  schema_version: 1;
  mode: "read-only-metadata";
  inventory_repositories: number;
  inventory_public: number;
  inventory_private: number;
  policy_referenced: number;
  active_policy_referenced: number;
  active_unmanaged: number;
  excluded_repositories: number;
  archived_repositories: number;
  policy_references_outside_installation: number;
  enforcement_verified: false;
  scanned_source_files: false;
  automatic_writes: false;
};

type AccessPolicy = {
  schema_version: number;
  organization: string;
  grants: Record<string, unknown>;
  excluded_repositories: string[];
};

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function summarizePrivacyCoverage(
  policyValue: unknown,
  inventoryValue: unknown
): PrivacyCoverageSummary {
  if (!isJsonRecord(policyValue)) throw new CliError("Repository policy is malformed.", 65);
  const policy = policyValue as unknown as AccessPolicy;
  if (
    policy.schema_version !== 1 ||
    typeof policy.organization !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(policy.organization) ||
    !isJsonRecord(policy.grants) ||
    !Array.isArray(policy.excluded_repositories) ||
    policy.excluded_repositories.some(
      (name) => typeof name !== "string" || !repositoryName.test(name)
    )
  ) {
    throw new CliError("Repository policy coverage fields are invalid.", 65);
  }
  if (!Array.isArray(inventoryValue) || inventoryValue.length > 10000) {
    throw new CliError("Repository installation inventory is unavailable or oversized.", 65);
  }
  const installed = new Set<string>();
  const excluded = new Set(policy.excluded_repositories);
  if (excluded.size !== policy.excluded_repositories.length) {
    throw new CliError("Repository exclusion policy contains duplicates.", 65);
  }
  const managed = new Set(Object.keys(policy.grants));
  if (
    [...managed, ...excluded].some(
      (name) => !repositoryName.test(name) || !name.startsWith(`${policy.organization}/`)
    )
  ) {
    throw new CliError("Repository access policy includes invalid organization names.", 65);
  }
  const summary: PrivacyCoverageSummary = {
    schema_version: 1,
    mode: "read-only-metadata",
    inventory_repositories: 0,
    inventory_public: 0,
    inventory_private: 0,
    policy_referenced: 0,
    active_policy_referenced: 0,
    active_unmanaged: 0,
    excluded_repositories: 0,
    archived_repositories: 0,
    policy_references_outside_installation: 0,
    enforcement_verified: false,
    scanned_source_files: false,
    automatic_writes: false,
  };
  for (const entry of inventoryValue) {
    if (!isJsonRecord(entry) || !isJsonRecord(entry.owner)) {
      throw new CliError("Repository installation inventory entry is invalid.", 65);
    }
    const owner = entry.owner.login;
    const name = entry.full_name;
    if (
      typeof name !== "string" ||
      !repositoryName.test(name) ||
      owner !== policy.organization ||
      !name.startsWith(`${policy.organization}/`) ||
      typeof entry.private !== "boolean" ||
      typeof entry.archived !== "boolean" ||
      installed.has(name)
    ) {
      throw new CliError(
        "Repository inventory is incomplete, duplicated or cross-organization.",
        65
      );
    }
    installed.add(name);
    summary.inventory_repositories++;
    if (entry.private) summary.inventory_private++;
    else summary.inventory_public++;
    if (entry.archived) summary.archived_repositories++;
    if (excluded.has(name)) summary.excluded_repositories++;
    if (managed.has(name)) {
      summary.policy_referenced++;
      if (!entry.archived) summary.active_policy_referenced++;
    } else if (!entry.archived && !excluded.has(name)) {
      summary.active_unmanaged++;
    }
  }
  summary.policy_references_outside_installation = [...managed].filter(
    (name) => !installed.has(name)
  ).length;
  return summary;
}

export async function readInstallationInventory(
  reader: Pick<GithubReader, "get">
): Promise<unknown[]> {
  const repositories: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await reader.get(`installation/repositories?per_page=100&page=${page}`);
    if (!isJsonRecord(response) || !Array.isArray(response.repositories)) {
      throw new CliError("Installation repository listing is malformed.", 75);
    }
    const entries = response.repositories;
    if (entries.length > 100) throw new CliError("Installation repository page is oversized.", 75);
    repositories.push(...entries);
    if (entries.length < 100) return repositories;
  }
  throw new CliError("Installation repository listing exceeds the page budget.", 75);
}

async function main(): Promise<void> {
  const token = process.env.AW_INVENTORY_TOKEN;
  if (!token) throw new CliError("Read-only inventory credential is missing.", 77);
  let summary: PrivacyCoverageSummary;
  try {
    const policy = JSON.parse(await readFile("policies/repository-access.json", "utf8")) as unknown;
    const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
    summary = summarizePrivacyCoverage(policy, await readInstallationInventory(reader));
  } catch {
    // This is a public workflow. Never emit private repository names, API paths or values.
    throw new CliError("Privacy coverage inventory could not be verified; details withheld.", 75);
  }
  console.log(JSON.stringify(summary));
  if (summary.active_unmanaged > 0) {
    throw new CliError(
      "Some accessible active repositories lack a governance policy reference.",
      1
    );
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
