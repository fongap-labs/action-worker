import { readFile } from "node:fs/promises";
import {
  parseNamesOnlyInventory,
  verifyPinnedTaskSource,
} from "./audit-task-secret-scope.ts";
import type { ScopedTaskSecretPlan } from "./resolve-task-secret-plan.ts";
import { resolveTaskSecretPlan } from "./resolve-task-secret-plan.ts";
import { CliError, isMain } from "./runtime-command.ts";

type VariableInventory = ReturnType<typeof parseNamesOnlyInventory>;

type VariableAudit = {
  status: "UNVERIFIED";
  source_policy_binding_checked: true;
  inventory_claims_complete: boolean;
  required_variable_count: number;
  aliased_required_count: number;
  repository_name_matches: number;
  organization_name_matches: number;
  environment_only_names: number;
  missing_from_complete_inventory: number | null;
  scope_unknown_names: number | null;
  actual_variable_values_checked: false;
  runtime_injection_proven: false;
};

/** Only names and declared scopes are acceptable. Never include variable values. */
export function auditTaskVariableScope(
  plan: ScopedTaskSecretPlan,
  inventory: VariableInventory
): VariableAudit {
  if (
    plan.schema_version !== 1 ||
    !Array.isArray(plan.slots) ||
    plan.slots.length > 32
  ) {
    throw new CliError("Invalid approved task variable slot plan.", 65);
  }
  const repositoryNames = new Set(inventory.repository);
  const organizationNames = new Set(inventory.organization_accessible);
  const environmentNames = new Set(Object.values(inventory.environments).flat());
  const required = plan.slots.filter((slot) => slot.kind === "variable" && slot.required);
  let repoCount = 0;
  let orgCount = 0;
  let environmentOnly = 0;
  let missing = 0;
  let aliases = 0;
  for (const slot of required) {
    if (
      typeof slot.logical_name !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(slot.logical_name) ||
      typeof slot.stored_name !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(slot.stored_name)
    ) {
      throw new CliError("Invalid approved task Variable slot binding.", 65);
    }
    if (slot.stored_name !== slot.logical_name) aliases += 1;
    if (repositoryNames.has(slot.stored_name)) repoCount += 1;
    else if (organizationNames.has(slot.stored_name)) orgCount += 1;
    else if (environmentNames.has(slot.stored_name)) environmentOnly += 1;
    else missing += 1;
  }
  const isComplete = inventory.coverage === "complete";
  return {
    status: "UNVERIFIED",
    source_policy_binding_checked: true,
    inventory_claims_complete: isComplete,
    required_variable_count: required.length,
    aliased_required_count: aliases,
    repository_name_matches: repoCount,
    organization_name_matches: orgCount,
    environment_only_names: environmentOnly,
    missing_from_complete_inventory: isComplete ? missing : null,
    scope_unknown_names: isComplete ? null : missing,
    actual_variable_values_checked: false,
    runtime_injection_proven: false,
  };
}

async function main(): Promise<void> {
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new CliError("Variable scope audit is restricted to an offline authorized terminal.", 77);
  }
  const args = process.argv.slice(2);
  const [sourceRoot = "", repository = "", project = "", expectedSha = "", inventoryPath = ""] =
    args;
  if (args.length !== 5 || !sourceRoot || !repository || !project || !expectedSha || !inventoryPath) {
    throw new CliError(
      "Usage: audit-task-variable-scope.ts <pinned-source-root> <repository> <project> <full-source-sha> <variable-names-only.json>",
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
  console.log(JSON.stringify(auditTaskVariableScope(plan, inventory), null, 2));
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    console.error("Variable scope audit failed; inspect names and files in the private terminal.");
    process.exitCode = 77;
  });
}
