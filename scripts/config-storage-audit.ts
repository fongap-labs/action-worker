import { readFile } from "node:fs/promises";
import { minimumConfigImpact } from "./config-security-classification.ts";
import { GithubHttpError, GithubReader, isJsonRecord } from "./github-api.ts";
import { readRepositoryPolicyText } from "./repository-policy.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

// GitHub Secrets APIs return metadata, never the Secret value.
// Variables APIs can return values; intentionally retain only their names in memory.
const REPOSITORY_PREFIX = "fongap-labs/";
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const namePattern = /^[A-Z][A-Z0-9_]*$/;
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;

type Reader = Pick<GithubReader, "get">;
type OrgEntry = { name: string; visibility: "all" | "private" | "selected"; selected: Set<number> };
type RepositoryInfo = { id: number; private: boolean };

export type StorageAuditSummary = {
  schema_version: 1;
  mode: "read-only-storage-metadata";
  coverage: "complete" | "control-only";
  organization_scope_verified: boolean;
  repositories_verified: number;
  repository_secrets: number;
  repository_variables: number;
  environment_count: number;
  environment_secrets: number | null;
  environment_secret_scope_verified: boolean;
  environment_variables: number;
  organization_secrets: number | null;
  organization_variables: number | null;
  inherited_secret_bindings: number | null;
  inherited_variable_bindings: number | null;
  repository_shadowed_secret_bindings: number | null;
  repository_shadowed_variable_bindings: number | null;
  environment_shadowed_secret_bindings: number | null;
  environment_shadowed_variable_bindings: number | null;
  protected_variable_bindings: number | null;
  authorization_variable_bindings: number | null;
  root_trust_variable_bindings: number | null;
  secret_values_read: false;
  secret_values_verified: false;
  consumer_credentials_verified: false;
  environment_protection_verified: false;
  automatic_writes: false;
};

/** Include newly enrolled governed repositories automatically without granting permissions. */
export function managedAuditTargets(
  discovery: readonly string[],
  authorized: readonly string[]
): string[] {
  const names = [...new Set([...discovery, ...authorized])];
  if (
    names.length === 0 ||
    names.length > 100 ||
    names.some((name) => !repositoryPattern.test(name)) ||
    new Set(discovery).size !== discovery.length ||
    new Set(authorized).size !== authorized.length
  ) {
    throw new CliError("Configuration audit repository targets are invalid.", 65);
  }
  return names.sort();
}

/** Classifies API permission failures without exposing repository or Secret names. */
export function storageAuditFailureScope(
  path: string
): "organization" | "environment" | "repository" {
  if (path.startsWith("orgs/fongap-labs/")) return "organization";
  if (path.includes("/environments")) return "environment";
  return "repository";
}

function nonSensitiveName(value: unknown): string {
  if (!isJsonRecord(value) || typeof value.name !== "string" || !namePattern.test(value.name)) {
    throw new CliError("Configuration inventory returned an invalid name.", 65);
  }
  return value.name;
}

async function listAll(reader: Reader, path: string, key: string): Promise<unknown[]> {
  const collected: unknown[] = [];
  let expected = -1;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await reader.get(
      path + (path.includes("?") ? "&" : "?") + "per_page=" + PAGE_SIZE + "&page=" + page
    );
    if (
      !isJsonRecord(response) ||
      !Number.isSafeInteger(response.total_count) ||
      (response.total_count as number) < 0 ||
      !Array.isArray(response[key])
    ) {
      throw new CliError("Configuration inventory metadata is incomplete.", 65);
    }
    const count = response.total_count as number;
    if (expected === -1) expected = count;
    if (count !== expected) {
      throw new CliError("Configuration inventory changed during pagination.", 77);
    }
    const entries = response[key] as unknown[];
    if (entries.length > PAGE_SIZE || (entries.length === 0 && collected.length < expected)) {
      throw new CliError("Configuration inventory pagination is incomplete.", 77);
    }
    collected.push(...entries);
    if (collected.length >= expected) {
      if (collected.length !== expected) {
        throw new CliError("Configuration inventory has duplicate or inconsistent pages.", 77);
      }
      return collected;
    }
  }
  throw new CliError("Configuration inventory exceeds the approved page limit.", 77);
}

async function selectedRepositoryIds(
  reader: Reader,
  name: string,
  type: "secrets" | "variables"
): Promise<Set<number>> {
  const entries = await listAll(
    reader,
    "orgs/fongap-labs/actions/" + type + "/" + encodeURIComponent(name) + "/repositories",
    "repositories"
  );
  const ids = new Set<number>();
  for (const entry of entries) {
    if (!isJsonRecord(entry) || !Number.isSafeInteger(entry.id) || (entry.id as number) < 1) {
      throw new CliError("Configuration inventory repository selection is invalid.", 65);
    }
    ids.add(entry.id as number);
  }
  if (ids.size !== entries.length) {
    throw new CliError("Configuration inventory repository selection is duplicated.", 65);
  }
  return ids;
}

async function organizationEntries(
  reader: Reader,
  type: "secrets" | "variables"
): Promise<OrgEntry[]> {
  const entries = await listAll(reader, "orgs/fongap-labs/actions/" + type, type);
  const results: OrgEntry[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const name = nonSensitiveName(entry);
    if (names.has(name) || !isJsonRecord(entry)) {
      throw new CliError("Configuration inventory contains duplicate organization entries.", 65);
    }
    names.add(name);
    const visibility = entry.visibility;
    if (visibility !== "all" && visibility !== "private" && visibility !== "selected") {
      throw new CliError("Configuration inventory organization visibility is unknown.", 65);
    }
    results.push({
      name,
      visibility,
      selected:
        visibility === "selected" ? await selectedRepositoryIds(reader, name, type) : new Set(),
    });
  }
  return results;
}

function inherited(entries: readonly OrgEntry[], repository: RepositoryInfo): Set<string> {
  return new Set(
    entries
      .filter(
        (entry) =>
          entry.visibility === "all" ||
          (entry.visibility === "private" && repository.private) ||
          (entry.visibility === "selected" && entry.selected.has(repository.id))
      )
      .map((entry) => entry.name)
  );
}

function environmentNames(entries: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (
      !isJsonRecord(entry) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      entry.name.length > 255 ||
      Array.from(entry.name).some((character) => character.charCodeAt(0) < 32) ||
      names.has(entry.name)
    ) {
      throw new CliError("Configuration inventory contains invalid environment metadata.", 65);
    }
    names.add(entry.name);
  }
  return names;
}

function namesOf(entries: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    const name = nonSensitiveName(entry);
    if (names.has(name)) {
      throw new CliError("Configuration inventory contains duplicate names.", 65);
    }
    names.add(name);
  }
  return names;
}

function countShadowed(higher: ReadonlySet<string>, lower: ReadonlySet<string>): number {
  let count = 0;
  for (const name of higher) if (lower.has(name)) count++;
  return count;
}

function countImpacted(names: ReadonlySet<string>): {
  protected: number;
  authorization: number;
  rootTrust: number;
} {
  let protectedCount = 0;
  let authorization = 0;
  let rootTrust = 0;
  for (const name of names) {
    const impact = minimumConfigImpact(name);
    if (impact !== "ordinary-business") protectedCount++;
    if (impact === "authorization-policy") authorization++;
    if (impact === "root-trust") rootTrust++;
  }
  return { protected: protectedCount, authorization, rootTrust };
}

function addImpacted(result: StorageAuditSummary, names: ReadonlySet<string>): void {
  const counts = countImpacted(names);
  result.protected_variable_bindings = (result.protected_variable_bindings ?? 0) + counts.protected;
  result.authorization_variable_bindings =
    (result.authorization_variable_bindings ?? 0) + counts.authorization;
  result.root_trust_variable_bindings =
    (result.root_trust_variable_bindings ?? 0) + counts.rootTrust;
}

function repositoryInfo(value: unknown): RepositoryInfo {
  if (
    !isJsonRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.private !== "boolean"
  ) {
    throw new CliError("Configuration inventory repository identity is invalid.", 65);
  }
  return { id: value.id as number, private: value.private };
}

export async function auditStorageMetadata(
  reader: Reader,
  repositories: readonly string[],
  options: { skipOrganization?: boolean; allowEnvironmentSecretPermissionGap?: boolean } = {}
): Promise<StorageAuditSummary> {
  if (
    repositories.length === 0 ||
    new Set(repositories).size !== repositories.length ||
    repositories.some((name) => !repositoryPattern.test(name)) ||
    (options.skipOrganization === true &&
      (repositories.length !== 1 || repositories[0] !== "fongap-labs/action-worker")) ||
    (options.allowEnvironmentSecretPermissionGap === true && !options.skipOrganization)
  ) {
    throw new CliError("Configuration inventory targets are invalid.", 65);
  }
  const result: StorageAuditSummary = {
    schema_version: 1,
    mode: "read-only-storage-metadata",
    coverage: options.skipOrganization ? "control-only" : "complete",
    organization_scope_verified: !options.skipOrganization,
    repositories_verified: 0,
    repository_secrets: 0,
    repository_variables: 0,
    environment_count: 0,
    environment_secrets: 0,
    environment_secret_scope_verified: true,
    environment_variables: 0,
    organization_secrets: 0,
    organization_variables: 0,
    inherited_secret_bindings: 0,
    inherited_variable_bindings: 0,
    repository_shadowed_secret_bindings: 0,
    repository_shadowed_variable_bindings: 0,
    environment_shadowed_secret_bindings: 0,
    environment_shadowed_variable_bindings: 0,
    protected_variable_bindings: 0,
    authorization_variable_bindings: 0,
    root_trust_variable_bindings: 0,
    secret_values_read: false,
    secret_values_verified: false,
    consumer_credentials_verified: false,
    environment_protection_verified: false,
    automatic_writes: false,
  };
  const orgSecrets = options.skipOrganization ? [] : await organizationEntries(reader, "secrets");
  const orgVariables = options.skipOrganization
    ? []
    : await organizationEntries(reader, "variables");
  result.organization_secrets = orgSecrets.length;
  result.organization_variables = orgVariables.length;

  for (const repository of repositories) {
    if (!repository.startsWith(REPOSITORY_PREFIX)) {
      throw new CliError("Configuration inventory repository owner is invalid.", 65);
    }
    const metadata = repositoryInfo(await reader.get("repos/" + repository));
    const repoSecrets = namesOf(
      await listAll(reader, "repos/" + repository + "/actions/secrets", "secrets")
    );
    const repoVariables = namesOf(
      await listAll(reader, "repos/" + repository + "/actions/variables", "variables")
    );
    const inheritedSecrets = inherited(orgSecrets, metadata);
    const inheritedVariables = inherited(orgVariables, metadata);
    result.repository_secrets += repoSecrets.size;
    result.repository_variables += repoVariables.size;
    result.inherited_secret_bindings =
      (result.inherited_secret_bindings ?? 0) + inheritedSecrets.size;
    result.inherited_variable_bindings =
      (result.inherited_variable_bindings ?? 0) + inheritedVariables.size;
    result.repository_shadowed_secret_bindings =
      (result.repository_shadowed_secret_bindings ?? 0) +
      countShadowed(repoSecrets, inheritedSecrets);
    result.repository_shadowed_variable_bindings =
      (result.repository_shadowed_variable_bindings ?? 0) +
      countShadowed(repoVariables, inheritedVariables);
    addImpacted(result, repoVariables);
    addImpacted(result, inheritedVariables);

    const environments = await listAll(
      reader,
      "repos/" + repository + "/environments",
      "environments"
    );
    result.environment_count += environments.length;
    const environmentsByName = environmentNames(environments);
    for (const name of environmentsByName) {
      const url = "repos/" + repository + "/environments/" + encodeURIComponent(name);
      let environmentSecrets = new Set<string>();
      if (result.environment_secret_scope_verified) {
        try {
          environmentSecrets = namesOf(await listAll(reader, url + "/secrets", "secrets"));
        } catch (error) {
          if (
            !options.allowEnvironmentSecretPermissionGap ||
            !(error instanceof GithubHttpError) ||
            error.status !== 403 ||
            error.kind !== "permission"
          ) {
            throw error;
          }
          // Secret names are unknown, not absent. Stop attempting further
          // Environment Secret endpoints while still checking Variables.
          result.environment_secret_scope_verified = false;
        }
      }
      const environmentVariables = namesOf(await listAll(reader, url + "/variables", "variables"));
      result.environment_secrets = (result.environment_secrets ?? 0) + environmentSecrets.size;
      result.environment_variables += environmentVariables.size;
      result.environment_shadowed_secret_bindings =
        (result.environment_shadowed_secret_bindings ?? 0) +
        countShadowed(environmentSecrets, new Set([...repoSecrets, ...inheritedSecrets]));
      result.environment_shadowed_variable_bindings =
        (result.environment_shadowed_variable_bindings ?? 0) +
        countShadowed(environmentVariables, new Set([...repoVariables, ...inheritedVariables]));
      addImpacted(result, environmentVariables);
    }
    result.repositories_verified++;
  }
  if (!result.environment_secret_scope_verified) {
    result.environment_secrets = null;
    result.environment_shadowed_secret_bindings = null;
  }
  if (options.skipOrganization) {
    // Without organization access, all inheritance-dependent counters are unknown,
    // not zero. Repository and Environment name counts remain locally verifiable.
    result.organization_secrets = null;
    result.organization_variables = null;
    result.inherited_secret_bindings = null;
    result.inherited_variable_bindings = null;
    result.repository_shadowed_secret_bindings = null;
    result.repository_shadowed_variable_bindings = null;
    result.environment_shadowed_secret_bindings = null;
    result.environment_shadowed_variable_bindings = null;
    result.protected_variable_bindings = null;
    result.authorization_variable_bindings = null;
    result.root_trust_variable_bindings = null;
  }
  return result;
}

async function main(): Promise<void> {
  const token = process.env.AW_CONFIG_AUDIT_READ_TOKEN ?? "";
  if (!token) throw new CliError("Read-only configuration audit identity is not configured.", 77);
  const raw: unknown = JSON.parse(await readFile("policies/config-audit-targets.json", "utf8"));
  if (!isJsonRecord(raw) || raw.schema_version !== 1 || !Array.isArray(raw.repositories)) {
    throw new CliError("Read-only configuration audit targets are invalid.", 65);
  }
  const repositories = raw.repositories;
  if (repositories.some((value) => typeof value !== "string")) {
    throw new CliError("Read-only configuration audit targets are invalid.", 65);
  }
  const authorized = JSON.parse(readRepositoryPolicyText()) as Record<string, unknown>;
  const auditTargets = managedAuditTargets(repositories as string[], Object.keys(authorized));
  const api = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token, {
    attemptLimit: 2,
  });
  let failureScope: "organization" | "environment" | "repository" = "organization";
  const reader = {
    async get(path: string): Promise<unknown> {
      failureScope = storageAuditFailureScope(path);
      return await api.get(path);
    },
  };
  try {
    // Complete scope is preferred. A denied organization metadata permission does
    // not prevent useful read-only evidence about the central ops repository.
    let summary: StorageAuditSummary;
    try {
      summary = await auditStorageMetadata(reader, auditTargets);
    } catch (error) {
      if (
        failureScope !== "organization" ||
        !(error instanceof GithubHttpError) ||
        error.status !== 403 ||
        error.kind !== "permission"
      ) {
        throw error;
      }
      console.warn(
        "::warning::Organization metadata access denied; auditing only the Action Worker control repository. Inherited scope remains unverified."
      );
      summary = await auditStorageMetadata(reader, ["fongap-labs/action-worker"], {
        skipOrganization: true,
        allowEnvironmentSecretPermissionGap: true,
      });
    }
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    const failure =
      error instanceof GithubHttpError ? `http_${error.status}_${error.kind}` : "unclassified";
    console.error(
      `::error::Organization configuration scope audit blocked in ${failureScope} metadata (${failure}); no inventory or values published.`
    );
    throw new CliError("Read-only storage audit incomplete; no report published.", 77);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
