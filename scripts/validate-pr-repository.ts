import {
  CliError,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateRepository(repository: string, allowValue: unknown): void {
  if (!repositoryPattern.test(repository)) {
    throw new CliError(`::error::Invalid PR repository: ${repository}.`, 64);
  }
  if (
    !Array.isArray(allowValue)
    || allowValue.length === 0
    || !allowValue.every((item) => typeof item === "string" && repositoryPattern.test(item))
    || new Set(allowValue).size !== allowValue.length
  ) {
    throw new CliError("::error::PR_REPOSITORY_ALLOWLIST must be a non-empty, unique repository JSON array.", 65);
  }
  if (!allowValue.includes(repository)) {
    throw new CliError(`::error::PR repository is not allowed: ${repository}.`, 77);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new CliError("Usage: validate-pr-repository.ts <repository>", 64);
  }
  const allowlist = process.env.PR_REPOSITORY_ALLOWLIST;
  if (!allowlist) {
    throw new CliError("::error::Missing Repository Variable: PR_REPOSITORY_ALLOWLIST.", 65);
  }
  const repository = args[0] ?? "";
  validateRepository(repository, parseJson(allowlist, "::error::PR_REPOSITORY_ALLOWLIST must be valid JSON."));
  console.log(`PR repository allowed: ${repository}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
