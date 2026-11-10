import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNamesOnlyInventory } from "./audit-task-secret-scope.ts";
import type { DeploySecretPlanEntry } from "./resolve-secret-scope.ts";
import {
  readDeploySecretVariableSources,
  resolveDeploySecretPlan,
} from "./resolve-secret-scope.ts";
import { CliError, isMain, runText } from "./runtime-command.ts";
import { selectDeployCredentialEnvironment } from "./select-deploy-credential-environment.ts";

type NamesOnlyInventory = ReturnType<typeof parseNamesOnlyInventory>;

type DeployScopeAudit = {
  status: "UNVERIFIED";
  source_policy_binding_checked: true;
  inventory_claims_complete: boolean;
  required_secret_count: number;
  aliased_required_count: number;
  repository_name_matches: number;
  organization_name_matches: number;
  active_environment_name_matches: number;
  other_environment_only_names: number;
  missing_from_complete_inventory: number | null;
  scope_unknown_names: number | null;
  actual_secret_values_checked: false;
  runtime_injection_proven: false;
  deployment_success_proven: false;
};

/** The deploy job is bound to one Environment; names in other Environments are not visible. */
export function auditDeploySecretScope(
  plan: readonly DeploySecretPlanEntry[],
  inventory: NamesOnlyInventory,
  activeEnvironment: string
): DeployScopeAudit {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(activeEnvironment) ||
    plan.filter((entry) => entry.kind === "secret").length > 40
  ) {
    throw new CliError("Invalid deploy Secret audit context.", 65);
  }
  const seen = new Set<string>();
  for (const entry of plan) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(entry.name) ||
      !/^[A-Z][A-Z0-9_]*$/.test(entry.source) ||
      (entry.kind !== "secret" && entry.kind !== "variable") ||
      typeof entry.required !== "boolean" ||
      seen.has(entry.name)
    ) {
      throw new CliError("Invalid approved deploy Secret binding.", 65);
    }
    seen.add(entry.name);
  }
  const repository = new Set(inventory.repository);
  const organization = new Set(inventory.organization_accessible);
  const active = new Set(inventory.environments[activeEnvironment] ?? []);
  const other = new Set(
    Object.entries(inventory.environments)
      .filter(([name]) => name !== activeEnvironment)
      .flatMap(([, names]) => names)
  );
  const required = plan.filter((entry) => entry.required && entry.kind === "secret");
  let repositoryCount = 0;
  let organizationCount = 0;
  let activeCount = 0;
  let otherCount = 0;
  let missingCount = 0;
  let aliasedCount = 0;
  for (const entry of required) {
    if (entry.name !== entry.source) aliasedCount += 1;
    if (repository.has(entry.source)) repositoryCount += 1;
    else if (organization.has(entry.source)) organizationCount += 1;
    else if (active.has(entry.source)) activeCount += 1;
    else if (other.has(entry.source)) otherCount += 1;
    else missingCount += 1;
  }
  const complete = inventory.coverage === "complete";
  return {
    status: "UNVERIFIED",
    source_policy_binding_checked: true,
    inventory_claims_complete: complete,
    required_secret_count: required.length,
    aliased_required_count: aliasedCount,
    repository_name_matches: repositoryCount,
    organization_name_matches: organizationCount,
    active_environment_name_matches: activeCount,
    other_environment_only_names: otherCount,
    missing_from_complete_inventory: complete ? missingCount : null,
    scope_unknown_names: complete ? null : missingCount,
    actual_secret_values_checked: false,
    runtime_injection_proven: false,
    deployment_success_proven: false,
  };
}

/** Pin the exact source commit and reject dirty or unsafe deploy declarations. */
export async function verifyPinnedDeploySource(
  sourceRoot: string,
  product: string,
  expectedSha: string
): Promise<{ requiredPath: string; allowedPath: string }> {
  if (
    (product && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(product)) ||
    !/^[0-9a-f]{40}$/.test(expectedSha)
  ) {
    throw new CliError("Pinned deploy source identity is invalid.", 64);
  }
  const directory = product ? `projects/${product}` : ".github";
  const paths = ["deploy.secrets.required", "deploy.secrets.allowed"].map(
    (file) => `${directory}/${file}`
  );
  const head = await runText("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    timeoutMs: 5000,
    maxBuffer: 256,
  });
  const changes = await runText(
    "git",
    ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=all", "--", ...paths],
    { timeoutMs: 5000, maxBuffer: 4096 }
  );
  if (head.trim().toLowerCase() !== expectedSha || changes.trim() !== "") {
    throw new CliError("Pinned deploy source identity or declarations changed.", 77);
  }
  for (const path of paths) {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(join(sourceRoot, path));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.nlink !== 1 ||
      details.size > 16384
    ) {
      throw new CliError("Deploy Secret declaration must be a bounded regular file.", 77);
    }
  }
  return { requiredPath: join(sourceRoot, paths[0]!), allowedPath: join(sourceRoot, paths[1]!) };
}

async function main(): Promise<void> {
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new CliError("Deploy Secret scope audit is restricted to an offline terminal.", 77);
  }
  const args = process.argv.slice(2);
  const [
    sourceRoot = "",
    repository = "",
    environment = "",
    productArg = "",
    sha = "",
    inventoryPath = "",
  ] = args;
  if (
    args.length !== 6 ||
    !sourceRoot ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(environment) ||
    !productArg ||
    !inventoryPath
  ) {
    throw new CliError(
      "Usage: audit-deploy-secret-scope.ts <pinned-source-root> <repository> <environment> <product-or-dash> <full-source-sha> <names-only.json>",
      64
    );
  }
  const product = productArg === "-" ? "" : productArg;
  const { requiredPath, allowedPath } = await verifyPinnedDeploySource(sourceRoot, product, sha);
  const policyPath = "policies/deploy-secrets.json";
  const sources = await readDeploySecretVariableSources(
    policyPath,
    repository,
    environment,
    product
  );
  // Supply placeholders ONLY to the offline policy resolver to inspect binding names.
  // No actual values are fetched, and the production runtime admission is untouched.
  const offlineVariableNames: NodeJS.ProcessEnv = Object.fromEntries(
    [...sources].map((name) => [name, "__OFFLINE_NAMES_ONLY__"])
  );
  const plan = await resolveDeploySecretPlan(
    requiredPath,
    allowedPath,
    policyPath,
    repository,
    environment,
    product,
    offlineVariableNames
  );
  const inventory = parseNamesOnlyInventory(
    JSON.parse(await readFile(inventoryPath, "utf8")) as unknown
  );
  const credentialRoutes: unknown = JSON.parse(
    await readFile("policies/deploy-credential-environments.json", "utf8")
  );
  const grantedEnvironments = JSON.parse(
    await readFile("policies/deploy-environments.json", "utf8")
  ) as { schema_version?: number; repositories?: Record<string, string[]> };
  if (grantedEnvironments.schema_version !== 1 || !grantedEnvironments.repositories) {
    throw new CliError("Deploy Environment authorization policy is invalid.", 65);
  }
  const { credential_environment } = selectDeployCredentialEnvironment(
    credentialRoutes,
    grantedEnvironments.repositories,
    repository,
    product,
    environment
  );
  console.log(JSON.stringify(auditDeploySecretScope(plan, inventory, credential_environment), null, 2));
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    console.error("Deploy Secret scope audit failed; inspect inputs only in the private terminal.");
    process.exitCode = 77;
  });
}
