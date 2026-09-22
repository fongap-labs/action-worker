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
    throw new CliError("::error::AW_PR_REPOSITORY_ALLOWLIST must be a non-empty, unique repository JSON array.", 65);
  }
  if (!allowValue.includes(repository)) {
    throw new CliError(`::error::PR repository is not allowed: ${repository}.`, 77);
  }
}
