import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

export const repositoryCapabilities = [
  "pr",
  "task",
  "release-source",
  "release-target",
] as const;

export type RepositoryCapability = typeof repositoryCapabilities[number];

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const capabilitySet = new Set<string>(repositoryCapabilities);

export function parseRepositoryPolicy(value: unknown): Record<string, RepositoryCapability[]> {
  if (!isJsonRecord(value) || Object.keys(value).length === 0) {
    throw new CliError("::error::AW_REPOSITORY_POLICY must be a non-empty repository policy JSON object.", 65);
  }
  const policy: Record<string, RepositoryCapability[]> = {};
  for (const [repository, rawCapabilities] of Object.entries(value)) {
    if (!repositoryPattern.test(repository)) {
      throw new CliError(`::error::Invalid repository in AW_REPOSITORY_POLICY: ${repository}.`, 65);
    }
    if (
      !Array.isArray(rawCapabilities)
      || rawCapabilities.length === 0
      || !rawCapabilities.every((item) => typeof item === "string" && capabilitySet.has(item))
      || new Set(rawCapabilities).size !== rawCapabilities.length
    ) {
      throw new CliError(`::error::Invalid capabilities for repository in AW_REPOSITORY_POLICY: ${repository}.`, 65);
    }
    policy[repository] = rawCapabilities as RepositoryCapability[];
  }
  return policy;
}

export function repositoriesForCapability(
  value: unknown,
  capability: RepositoryCapability,
): string[] {
  const policy = parseRepositoryPolicy(value);
  return Object.entries(policy)
    .filter(([, capabilities]) => capabilities.includes(capability))
    .map(([repository]) => repository)
    .sort();
}

export function validateRepositoryCapability(
  repository: string,
  value: unknown,
  capability: RepositoryCapability,
): void {
  if (!repositoryPattern.test(repository)) {
    throw new CliError(`::error::Invalid repository: ${repository}.`, 64);
  }
  const policy = parseRepositoryPolicy(value);
  if (!policy[repository]?.includes(capability)) {
    throw new CliError(`::error::Repository is not allowed for ${capability}: ${repository}.`, 77);
  }
}

async function main(): Promise<void> {
  const [command, first = "", second = ""] = process.argv.slice(2);
  const rawPolicy = process.env.AW_REPOSITORY_POLICY;
  if (!rawPolicy) {
    throw new CliError("::error::Missing Repository Variable: AW_REPOSITORY_POLICY.", 65);
  }
  const policy = parseJson(rawPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65);

  if (command === "list" && capabilitySet.has(first)) {
    const repositories = repositoriesForCapability(
      policy,
      first as RepositoryCapability,
    );
    if (repositories.length === 0) {
      throw new CliError(`::error::AW_REPOSITORY_POLICY has no repositories with capability: ${first}.`, 65);
    }
    await appendLines(process.env.GITHUB_OUTPUT, [
      `repositories=${JSON.stringify(repositories)}`,
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
    64,
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
