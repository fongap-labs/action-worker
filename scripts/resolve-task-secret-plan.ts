import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTaskCredentialSlotPlan, maxTaskCredentialSlots } from "./task-credential-slot-plan.ts";
import { parseTaskSecretDeclaration } from "./validate-task-secret-admission.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

export const taskSecretPlanFile = "action-worker-task-secret-plan.json";
export type ScopedTaskSecretPlan = {
  schema_version: 1;
  repository: string;
  project: string;
  slots: Awaited<ReturnType<typeof buildTaskCredentialSlotPlan>>;
};

async function readDeclaration(path: string): Promise<string[]> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.size > 16384) {
    throw new CliError("Task Secret declaration is not a bounded regular file.", 65);
  }
  return parseTaskSecretDeclaration(await readFile(path, "utf8"));
}

export async function resolveTaskSecretPlan(
  sourceRoot: string,
  policyPath: string,
  repository: string,
  project: string
): Promise<ScopedTaskSecretPlan> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(project)) {
    throw new CliError("Task Secret plan identity is invalid.", 64);
  }
  const directory = join(sourceRoot, "projects", project);
  const required = await readDeclaration(join(directory, ".secrets.required"));
  const allowed = await readDeclaration(join(directory, ".secrets.allowed"));
  const slots = await buildTaskCredentialSlotPlan(
    policyPath,
    repository,
    project,
    required,
    allowed
  );
  return { schema_version: 1, repository, project, slots };
}

export function validateTaskSecretSlots(
  plan: ScopedTaskSecretPlan,
  environment: NodeJS.ProcessEnv
): number {
  if (
    plan.schema_version !== 1 ||
    !Array.isArray(plan.slots) ||
    plan.slots.length > maxTaskCredentialSlots
  ) {
    throw new CliError("Task Secret slot plan is invalid.", 65);
  }
  const seen = new Set<string>();
  for (const [index, slot] of plan.slots.entries()) {
    if (
      slot.slot !== `AW_TASK_SECRET_SLOT_${String(index + 1).padStart(2, "0")}` ||
      !/^[A-Z][A-Z0-9_]*$/.test(slot.logical_name) ||
      !/^[A-Z][A-Z0-9_]*$/.test(slot.stored_name) ||
      typeof slot.required !== "boolean" ||
      seen.has(slot.logical_name)
    ) {
      throw new CliError("Task Secret slot plan has an invalid binding.", 65);
    }
    seen.add(slot.logical_name);
    if (slot.required && !environment[slot.slot]) {
      throw new CliError("A required task Secret slot has no value.", 77);
    }
  }
  return plan.slots.length;
}

async function main(): Promise<void> {
  const [mode = ""] = process.argv.slice(2);
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const repository = process.env.TASK_SOURCE_REPOSITORY ?? "";
  const project = process.env.PROJECT ?? "";
  if (!runnerTemp) throw new CliError("Task Secret plan requires RUNNER_TEMP.", 64);
  const path = join(runnerTemp, taskSecretPlanFile);
  if (mode === "resolve") {
    const source = process.env.AW_SOURCE_DIR ?? "";
    if (!source) throw new CliError("Task Secret plan source is missing.", 64);
    const plan = await resolveTaskSecretPlan(
      source,
      "policies/task-secrets.json",
      repository,
      project
    );
    await writeFile(path, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
    const values = Array.from({ length: maxTaskCredentialSlots }, (_, index) => {
      const name = plan.slots[index]?.stored_name ?? "";
      return `secret_${String(index).padStart(2, "0")}=${name}`;
    });
    await appendLines(process.env.GITHUB_OUTPUT, values);
    console.log(`Task Secret scope resolved: ${plan.slots.length} authorized slot(s); no values read.`);
  } else if (mode === "verify") {
    const plan = JSON.parse(await readFile(path, "utf8")) as ScopedTaskSecretPlan;
    if (plan.repository !== repository || plan.project !== project) {
      throw new CliError("Task Secret slot identity changed.", 65);
    }
    const count = validateTaskSecretSlots(plan, process.env);
    console.log(`Task Secret slots verified: ${count} scoped binding(s); values withheld.`);
  } else {
    throw new CliError("Usage: resolve-task-secret-plan.ts resolve|verify", 64);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
