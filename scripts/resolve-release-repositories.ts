import { resolveGithubApiScope } from "./resolve-github-api-scope.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

export function scopedReleaseRepositories(
  policy: unknown,
  controlRepository: string
): string[] {
  const [controlOwner = "", controlName = ""] = controlRepository.split("/");
  if (!controlOwner || !controlName) {
    throw new CliError("::error::A valid control repository is required.", 64);
  }

  const names = new Set([controlName]);
  for (const capability of ["release-source", "release-target"] as const) {
    for (const repository of repositoriesForCapability(policy, capability)) {
      const scope = resolveGithubApiScope(repository, controlRepository, policy, capability);
      names.add(scope.repository_name);
    }
  }
  return [...names].sort();
}

async function main(): Promise<void> {
  const policy = parseJson(
    process.env.AW_REPOSITORY_POLICY ?? "",
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65
  );
  const repositoryNames = scopedReleaseRepositories(policy, process.env.GITHUB_REPOSITORY ?? "");
  await appendLines(process.env.GITHUB_OUTPUT, [
    `repositories_csv=${repositoryNames.join(",")}`,
  ]);
  console.log(`Release scope includes ${repositoryNames.length} managed repositories.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
