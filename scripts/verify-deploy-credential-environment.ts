import { GithubHttpError, GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

type Reader = Pick<GithubReader, "get">;
const environmentPattern = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A GitHub Actions job may implicitly create a missing Environment. Fail
 * closed in the trusted prepare job, before any credential-bearing job starts.
 * This preflight checks metadata only and never reads Secret names or values.
 */
export async function assertExistingCredentialEnvironment(
  reader: Reader,
  repository: string,
  environment: string
): Promise<void> {
  if (
    repository !== "fongap-labs/action-worker" ||
    !environmentPattern.test(environment)
  ) {
    throw new CliError("Credential Environment preflight arguments are invalid.", 77);
  }
  let value: unknown;
  try {
    value = await reader.get(
      `repos/${repository}/environments/${encodeURIComponent(environment)}`
    );
  } catch (error) {
    throw new CliError(
      error instanceof GithubHttpError && error.status === 404
        ? `Credential Environment ${environment} does not exist; refusing implicit creation.`
        : `Credential Environment ${environment} cannot be verified; refusing deploy.`,
      77
    );
  }
  if (
    !isJsonRecord(value) ||
    value.name !== environment ||
    !Array.isArray(value.protection_rules)
  ) {
    throw new CliError("Credential Environment metadata is invalid; refusing deploy.", 65);
  }
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN;
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !token
  ) {
    throw new CliError("Credential Environment preflight requires approved central Actions.", 77);
  }
  await assertExistingCredentialEnvironment(
    new GithubReader(process.env.GITHUB_API_URL || "https://api.github.com", token),
    process.env.AW_CONTROL_REPOSITORY ?? "",
    process.env.DEPLOY_CREDENTIAL_ENVIRONMENT ?? ""
  );
  console.log("Credential Environment exists; no Secret metadata was accessed.");
}

if (isMain(import.meta.url)) main().catch(handleError);
