import { readFile } from "node:fs/promises";
import type { ScopedTaskSecretPlan } from "./resolve-task-secret-plan.ts";
import { resolveTaskSecretPlan } from "./resolve-task-secret-plan.ts";
import { CliError, isMain, runText } from "./runtime-command.ts";

type Inventory = {
  coverage: "complete" | "partial";
  repository: string[];
  organization_accessible: string[];
  environments: Record<string, string[]>;
};

type Audit = {
  status: "UNVERIFIED";
  source_policy_binding_checked: true;
  inventory_claims_complete: boolean;
  required_count: number;
  aliased_required_count: number;
  repository_name_matches: number;
  organization_name_matches: number;
  environment_only_names: number;
  missing_from_complete_inventory: number | null;
  scope_unknown_names: number | null;
  actual_secret_values_checked: false;
  runtime_injection_proven: false;
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("Invalid names-only Secret inventory.", 65);
  }
  return value as Record<string, unknown>;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 2048) {
    throw new CliError("Invalid Secret inventory names.", 65);
  }
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(item) || result.has(item)) {
      throw new CliError("Invalid or duplicate Secret inventory name.", 65);
    }
    result.add(item);
  }
  return [...result];
}

export function parseNamesOnlyInventory(raw: unknown): Inventory {
  const input = record(raw);
  const permitted = [
    "schema_version",
    "coverage",
    "repository",
    "organization_accessible",
    "environments",
  ];
  if (
    input.schema_version !== 1 ||
    (input.coverage !== "complete" && input.coverage !== "partial") ||
    Object.keys(input).some((key) => !permitted.includes(key))
  ) {
    throw new CliError("Secret inventory has an unsupported schema or field.", 65);
  }
  const environmentInput = record(input.environments);
  if (Object.keys(environmentInput).length > 100) {
    throw new CliError("Secret inventory has too many environments.", 65);
  }
  const environments: Record<string, string[]> = {};
  for (const [environment, stored] of Object.entries(environmentInput)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(environment)) {
      throw new CliError("Invalid environment identifier in inventory.", 65);
    }
    environments[environment] = names(stored);
  }
  return {
    coverage: input.coverage,
    repository: names(input.repository),
    organization_accessible: names(input.organization_accessible),
    environments,
  };
}

export function auditTaskSecretScope(plan: ScopedTaskSecretPlan, inventory: Inventory): Audit {
  if (plan.schema_version !== 1 || !Array.isArray(plan.slots) || plan.slots.length > 32) {
    throw new CliError("Invalid approved Secret slot plan.", 65);
  }
  const repository = new Set(inventory.repository);
  const organization = new Set(inventory.organization_accessible);
  const environments = new Set(Object.values(inventory.environments).flat());
  const required = plan.slots.filter((slot) => slot.required);
  let repoCount = 0;
  let orgCount = 0;
  let environmentOnly = 0;
  let missing = 0;
  let aliased = 0;

  for (const slot of required) {
    if (
      typeof slot.stored_name !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(slot.stored_name) ||
      typeof slot.logical_name !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(slot.logical_name)
    ) {
      throw new CliError("Invalid approved Secret slot binding.", 65);
    }
    if (slot.stored_name !== slot.logical_name) aliased += 1;
    if (repository.has(slot.stored_name)) {
      repoCount += 1;
    } else if (organization.has(slot.stored_name)) {
      orgCount += 1;
    } else if (environments.has(slot.stored_name)) {
      environmentOnly += 1;
    } else {
      missing += 1;
    }
  }
  const complete = inventory.coverage === "complete";
  return {
    status: "UNVERIFIED",
    source_policy_binding_checked: true,
    inventory_claims_complete: complete,
    required_count: required.length,
    aliased_required_count: aliased,
    repository_name_matches: repoCount,
    organization_name_matches: orgCount,
    environment_only_names: environmentOnly,
    missing_from_complete_inventory: complete ? missing : null,
    scope_unknown_names: complete ? null : missing,
    actual_secret_values_checked: false,
    runtime_injection_proven: false,
  };
}

/**
 * Validate the exact reviewed commit and the two source declaration files.
 * A matching HEAD alone is insufficient if the local checkout is dirty.
 */
export function assertPinnedTaskSource(
  expectedSha: string,
  headSha: string,
  declarationStatus: string
): void {
  if (
    !/^[0-9a-f]{40}$/.test(expectedSha) ||
    headSha.trim().toLowerCase() !== expectedSha ||
    declarationStatus.trim() !== ""
  ) {
    throw new CliError("Pinned source identity or declaration worktree changed.", 77);
  }
}

export async function verifyPinnedTaskSource(
  sourceRoot: string,
  project: string,
  expectedSha: string
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(project)) {
    throw new CliError("Pinned source project identity is invalid.", 64);
  }
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new CliError("A full immutable source SHA is required.", 64);
  }
  const headSha = await runText("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    timeoutMs: 5000,
    maxBuffer: 256,
  });
  const declarationStatus = await runText(
    "git",
    [
      "-C",
      sourceRoot,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      `projects/${project}/.secrets.required`,
      `projects/${project}/.secrets.allowed`,
    ],
    { timeoutMs: 5000, maxBuffer: 4096 }
  );
  assertPinnedTaskSource(expectedSha, headSha, declarationStatus);
}

async function main(): Promise<void> {
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new CliError("Secret scope audit is restricted to an offline authorized terminal.", 77);
  }
  const args = process.argv.slice(2);
  const [sourceRoot = "", repository = "", project = "", expectedSha = "", inventoryPath = ""] = args;
  if (args.length !== 5 || !sourceRoot || !repository || !project || !expectedSha || !inventoryPath) {
    throw new CliError(
      "Usage: audit-task-secret-scope.ts <pinned-source-root> <repository> <project> <full-source-sha> <inventory.json>",
      64
    );
  }
  await verifyPinnedTaskSource(sourceRoot, project, expectedSha);
  const plan = await resolveTaskSecretPlan(
    sourceRoot,
    "policies/task-secrets.json",
    repository,
    project
  );
  const inventory = parseNamesOnlyInventory(
    JSON.parse(await readFile(inventoryPath, "utf8")) as unknown
  );
  console.log(JSON.stringify(auditTaskSecretScope(plan, inventory), null, 2));
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    console.error("Secret scope audit failed; inspect names and files in the private terminal.");
    process.exitCode = 77;
  });
}
