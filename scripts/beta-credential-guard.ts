import { readFile } from "node:fs/promises";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

/**
 * Beta credentials may only come from an Environment of the exact same name.
 * Keep this gate independent of the legacy production route selector so a
 * future policy edit cannot silently route Beta to production ops Secrets.
 */
export function assertBetaCredentialScope(
  logicalEnvironment: string,
  credentialEnvironment: string
): void {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(logicalEnvironment) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(credentialEnvironment)
  ) {
    throw new CliError("Deployment credential environments are invalid.", 77);
  }
  if (logicalEnvironment.endsWith("-beta") && credentialEnvironment !== logicalEnvironment) {
    throw new CliError("Beta credential Environment must match the exact Beta target.", 77);
  }
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new CliError("Beta credential checks require trusted main-branch Actions.", 77);
  }
  // Parse the centrally owned route policy rather than accepting an untrusted
  // checkout's assertion about its deployment credentials.
  const policy = JSON.parse(
    await readFile("policies/deploy-credential-environments.json", "utf8")
  ) as unknown;
  if (
    !policy ||
    typeof policy !== "object" ||
    !("schema_version" in policy) ||
    policy.schema_version !== 1
  ) {
    throw new CliError("Central credential routing policy is invalid.", 65);
  }
  assertBetaCredentialScope(
    process.env.DEPLOY_ENVIRONMENT ?? "",
    process.env.DEPLOY_CREDENTIAL_ENVIRONMENT ?? ""
  );
  await appendLines(process.env.GITHUB_STEP_SUMMARY, ["- Beta credential routing: isolated"]);
}
if (isMain(import.meta.url)) main().catch(handleError);
