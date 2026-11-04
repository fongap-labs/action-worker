import { type RepositoryCapability, validateRepositoryCapability } from "./repository-policy.ts";
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
  capability: RepositoryCapability
): GithubApiScope {
  if (!repositoryPattern.test(controlRepository)) {
    throw new CliError("::error::GITHUB_REPOSITORY must be owner/repository.", 64);
  }
  validateRepositoryCapability(targetRepository, policy, capability);

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
  const capability = process.argv[2];
  if (capability !== "pr" && capability !== "deploy") {
    throw new CliError("Usage: resolve-github-api-scope.ts <pr|deploy>", 64);
  }
  const rawPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
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
  console.log(
    `GitHub API scope validated: ${scope.owner}/${scope.repository_name} -> ${scope.is_control_repository ? "GITHUB_TOKEN" : "GitHub App"}.`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
