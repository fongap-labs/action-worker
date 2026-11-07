import {
  parseRepositoryPolicy,
  readRepositoryPolicyText,
  repositoryCapabilities,
  type RepositoryCapability,
  validateRepositoryCapability,
} from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type GithubApiScope = {
  owner: string;
  repository_name: string;
  is_control_repository: boolean;
};

export function resolveGithubApiScope(
  targetRepository: string,
  controlRepository: string,
  policy: unknown,
  capability: RepositoryCapability | "managed"
): GithubApiScope {
  if (!repositoryPattern.test(controlRepository)) {
    throw new CliError("::error::GITHUB_REPOSITORY must be owner/repository.", 64);
  }
  if (capability === "managed") {
    if (!parseRepositoryPolicy(policy)[targetRepository]) {
      throw new CliError(
        `::error::Repository is not managed by this control plane: ${targetRepository}.`,
        77
      );
    }
  } else {
    validateRepositoryCapability(targetRepository, policy, capability);
  }

  const [controlOwner = ""] = controlRepository.split("/");
  const [targetOwner = "", targetName = ""] = targetRepository.split("/");
  if (controlOwner.toLowerCase() !== targetOwner.toLowerCase()) {
    throw new CliError(
      `::error::GitHub App API scope requires a managed repository in ${controlOwner}: ${targetRepository}. Cross-owner access requires a separate reviewed installation policy.`,
      77
    );
  }
  return {
    owner: controlOwner,
    repository_name: targetName,
    is_control_repository: controlRepository.toLowerCase() === targetRepository.toLowerCase(),
  };
}

async function main(): Promise<void> {
  const capability = process.argv[2] as RepositoryCapability | "managed";
  if (capability !== "managed" && !repositoryCapabilities.includes(capability)) {
    throw new CliError("Usage: resolve-github-api-scope.ts <managed|CAPABILITY>", 64);
  }
  const rawPolicy = readRepositoryPolicyText() ?? "";
  if (!rawPolicy) {
    throw new CliError("::error::AW_REPOSITORY_POLICY is required.", 65);
  }
  const scope = resolveGithubApiScope(
    process.env.TARGET_REPOSITORY ?? "",
    process.env.GITHUB_REPOSITORY ?? "",
    parseJson(rawPolicy, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    capability
  );
  await appendLines(process.env.GITHUB_OUTPUT, [
    `owner=${scope.owner}`,
    `repository_name=${scope.repository_name}`,
    `is_control_repository=${scope.is_control_repository}`,
  ]);
  console.log(`GitHub App API scope validated: ${scope.owner}/${scope.repository_name}.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
