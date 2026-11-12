import { readFile } from "node:fs/promises";
import { isDeployPolicyKey, productPolicyKey } from "./deploy-policy-key.ts";
import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const environmentPattern = /^[a-z][a-z0-9-]{0,63}$/;
const opsPattern = /^[a-z][a-z0-9-]{0,59}-ops$/;

export type CredentialEnvironmentSelection = {
  credential_environment: string;
  create_deployment: boolean;
};

/** Central policy cannot be supplied by an untrusted source repository. */
export function selectDeployCredentialEnvironment(
  policy: unknown,
  authorizedEnvironments: Readonly<Record<string, readonly string[]>>,
  repository: string,
  product: string,
  environment: string
): CredentialEnvironmentSelection {
  const key = productPolicyKey(repository, product);
  if (
    !isDeployPolicyKey(key) ||
    !environmentPattern.test(environment) ||
    !authorizedEnvironments[key]?.includes(environment)
  ) {
    throw new CliError("Deployment credential scope is not authorized.", 77);
  }
  if (!isJsonRecord(policy) || policy.schema_version !== 1 || !isJsonRecord(policy.routes)) {
    throw new CliError("Deployment credential Environment policy is invalid.", 65);
  }
  const opsOwners = new Map<string, string>();
  for (const [routeKey, entry] of Object.entries(policy.routes)) {
    if (!isDeployPolicyKey(routeKey) || !isJsonRecord(entry) || Object.keys(entry).length === 0) {
      throw new CliError("Deployment credential Environment policy entry is invalid.", 65);
    }
    if (!Object.hasOwn(authorizedEnvironments, routeKey)) {
      throw new CliError("Deployment credential Environment policy exceeds deploy grants.", 65);
    }
    for (const [logical, actual] of Object.entries(entry)) {
      if (
        !environmentPattern.test(logical) ||
        !authorizedEnvironments[routeKey]?.includes(logical) ||
        typeof actual !== "string" ||
        !opsPattern.test(actual)
      ) {
        throw new CliError("Deployment credential Environment route is invalid.", 65);
      }
      const owner = routeKey.split("/").slice(0, 2).join("/");
      const previous = opsOwners.get(actual);
      if (previous && previous !== owner) {
        throw new CliError("Deployment credentials cannot cross repository ops owners.", 65);
      }
      opsOwners.set(actual, owner);
    }
  }
  const route = policy.routes[key] as Record<string, unknown> | undefined;
  const actual = route?.[environment];
  return {
    credential_environment: typeof actual === "string" ? actual : environment,
    create_deployment: actual === undefined,
  };
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GITHUB_OUTPUT
  ) {
    throw new CliError("Deployment credential route requires approved main-branch Actions.", 77);
  }
  const routes = JSON.parse(await readFile("policies/deploy-credential-environments.json", "utf8"));
  const policy = JSON.parse(await readFile("policies/deploy-environments.json", "utf8")) as {
    schema_version?: number;
    repositories?: Record<string, string[]>;
  };
  if (policy.schema_version !== 1 || !isJsonRecord(policy.repositories)) {
    throw new CliError("Deployment environment authorization policy is invalid.", 65);
  }
  const selection = selectDeployCredentialEnvironment(
    routes,
    policy.repositories,
    process.env.DEPLOY_SOURCE_REPOSITORY ?? "",
    process.env.DEPLOY_PRODUCT ?? "",
    process.env.DEPLOY_ENVIRONMENT ?? ""
  );
  await appendLines(process.env.GITHUB_OUTPUT, [
    "credential_environment=" + selection.credential_environment,
    "create_deployment=" + selection.create_deployment,
  ]);
  console.log("Deployment credential Environment selected by central policy; no Secret accessed.");
}

if (isMain(import.meta.url)) main().catch(handleError);
