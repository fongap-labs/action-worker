import { readFileSync } from "node:fs";
import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

export const repositoryCapabilities = [
  "pr",
  "task",
  "release-source",
  "release-target",
  "deploy",
] as const;

export type RepositoryCapability = (typeof repositoryCapabilities)[number];
const canonicalPolicyFile = "policies/repository-access.json";

/** The versioned policy is authoritative: GitHub Actions variables cannot grant privileges. */
export function readRepositoryPolicyText(): string {
  // Test fixtures may supply synthetic repository identities only under Node's
  // test runner. Production jobs never accept environment-based grants.
  const fixture = process.env.NODE_TEST_CONTEXT ? process.env.AW_REPOSITORY_POLICY : "";
  if (fixture) {
    let value: unknown;
    try {
      value = JSON.parse(fixture) as unknown;
    } catch {
      throw new CliError("::error::Test repository policy fixture is invalid JSON.", 65);
    }
    return JSON.stringify(parseRepositoryPolicy(value));
  }
  const raw = readFileSync(canonicalPolicyFile, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    throw new CliError("::error::Repository access policy is invalid JSON.", 65);
  }
  if (
    !isJsonRecord(data) ||
    data.schema_version !== 1 ||
    data.organization !== "fongap-labs" ||
    !isJsonRecord(data.grants)
  ) {
    throw new CliError("::error::Repository access policy schema is invalid.", 65);
  }
  const grants = parseRepositoryPolicy(data.grants);
  if (Object.keys(grants).some((name) => !name.startsWith("fongap-labs/"))) {
    throw new CliError("::error::Repository access policy contains an outside organization.", 65);
  }
  return JSON.stringify(grants);
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const capabilitySet = new Set<string>(repositoryCapabilities);

export function parseRepositoryPolicy(value: unknown): Record<string, RepositoryCapability[]> {
  if (!isJsonRecord(value) || Object.keys(value).length === 0) {
    throw new CliError(
      "::error::AW_REPOSITORY_POLICY must be a non-empty repository policy JSON object.",
      65
    );
  }
  const policy: Record<string, RepositoryCapability[]> = {};
  for (const [repository, rawCapabilities] of Object.entries(value)) {
    if (!repositoryPattern.test(repository)) {
      throw new CliError(`::error::Invalid repository in AW_REPOSITORY_POLICY: ${repository}.`, 65);
    }
    if (
      !Array.isArray(rawCapabilities) ||
      rawCapabilities.length === 0 ||
      !rawCapabilities.every((item) => typeof item === "string" && capabilitySet.has(item)) ||
      new Set(rawCapabilities).size !== rawCapabilities.length
    ) {
      throw new CliError(
        `::error::Invalid capabilities for repository in AW_REPOSITORY_POLICY: ${repository}.`,
        65
      );
    }
    policy[repository] = rawCapabilities as RepositoryCapability[];
  }
  return policy;
}

export function repositoriesForCapability(
  value: unknown,
  capability: RepositoryCapability
): string[] {
  const policy = parseRepositoryPolicy(value);
  return Object.entries(policy)
    .filter(([, capabilities]) => capabilities.includes(capability))
    .map(([repository]) => repository)
    .sort();
}

/** True when the policy grants the capability; unlike validateRepositoryCapability it never throws for a missing grant. */
export function hasRepositoryCapability(
  repository: string,
  value: unknown,
  capability: RepositoryCapability
): boolean {
  return parseRepositoryPolicy(value)[repository]?.includes(capability) ?? false;
}

export function validateRepositoryCapability(
  repository: string,
  value: unknown,
  capability: RepositoryCapability
): void {
  if (!repositoryPattern.test(repository)) {
    const suggestions = suggestRepositories(value, repository);
    throw new CliError(
      `::error::Invalid repository: ${repository}. Enter it as owner/name${suggestions.length > 0 ? `, for example ${suggestions.join(" or ")}` : ""}.`,
      64
    );
  }
  const policy = parseRepositoryPolicy(value);
  if (!policy[repository]?.includes(capability)) {
    const allowed = repositoriesForCapability(policy, capability);
    throw new CliError(
      `::error::Repository is not allowed for ${capability}: ${repository}. Repositories with this capability: ${allowed.join(", ") || "none"}.`,
      77
    );
  }
}

/** Policy entries whose name part equals what was typed, so a bare name can be corrected. */
function suggestRepositories(value: unknown, typed: string): string[] {
  if (!isJsonRecord(value)) {
    return [];
  }
  const wanted = typed.toLowerCase();
  return Object.keys(value)
    .filter((name) => name.split("/")[1]?.toLowerCase() === wanted)
    .sort();
}

async function main(): Promise<void> {
  const [command, first = "", second = ""] = process.argv.slice(2);
  const policy = JSON.parse(readRepositoryPolicyText()) as Record<string, RepositoryCapability[]>;

  if (command === "list" && capabilitySet.has(first)) {
    const repositories = repositoriesForCapability(policy, first as RepositoryCapability);
    if (repositories.length === 0) {
      throw new CliError(
        `::error::AW_REPOSITORY_POLICY has no repositories with capability: ${first}.`,
        65
      );
    }
    const controlOwner = (process.env.GITHUB_REPOSITORY ?? "").split("/")[0] ?? "";
    const repositoryNames = repositories.map((repository) => {
      const [owner = "", name = ""] = repository.split("/");
      if (!controlOwner || owner.toLowerCase() !== controlOwner.toLowerCase() || !name) {
        throw new CliError(
          `::error::GitHub App repository scope must stay within ${controlOwner || "the control owner"}: ${repository}.`,
          77
        );
      }
      return name;
    });
    await appendLines(process.env.GITHUB_OUTPUT, [
      `repositories=${JSON.stringify(repositories)}`,
      `repositories_csv=${repositoryNames.join(",")}`,
    ]);
    console.log(`Repository policy resolved: ${first} -> ${repositories.length} repositories.`);
    return;
  }

  if (command === "validate" && capabilitySet.has(second)) {
    validateRepositoryCapability(first, policy, second as RepositoryCapability);
    console.log(`Repository policy validated: ${first} -> ${second}.`);
    return;
  }

  throw new CliError(
    "Usage: repository-policy.ts <list CAPABILITY | validate REPOSITORY CAPABILITY>",
    64
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
