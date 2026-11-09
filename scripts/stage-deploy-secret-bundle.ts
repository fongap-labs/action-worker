import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  deploySecretDirectory,
  deploySecretPlanPath,
  deploySecretSlots,
} from "./resolve-deploy-secret-plan.ts";
import type { DeploySecretPlanEntry } from "./resolve-secret-scope.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

type SecretPlan = {
  schema_version: 1;
  secrets: DeploySecretPlanEntry[];
};

function addMask(value: string): void {
  const escaped = value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stdout.write(`::add-mask::${escaped}\n`);
}

export async function stageDeploySecretSlots(
  environment: NodeJS.ProcessEnv,
  plan: SecretPlan,
  runnerTemp: string
): Promise<string[]> {
  if (plan.schema_version !== 1 || !Array.isArray(plan.secrets)) {
    throw new CliError("Deploy Secret plan is invalid.", 65);
  }
  const seenNames = new Set<string>();
  for (const entry of plan.secrets) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(entry.name) ||
      !/^[A-Z][A-Z0-9_]*$/.test(entry.source) ||
      (entry.kind !== "secret" && entry.kind !== "variable") ||
      typeof entry.required !== "boolean" ||
      seenNames.has(entry.name)
    ) {
      throw new CliError("Deploy Secret plan has an invalid or duplicated binding.", 65);
    }
    seenNames.add(entry.name);
  }
  const secretEntries = plan.secrets.filter((entry) => entry.kind === "secret");
  if (secretEntries.length > deploySecretSlots) {
    throw new CliError("Deploy Secret plan exceeds the fixed slot limit.", 65);
  }
  const values: string[] = [];
  for (let index = 0; index < deploySecretSlots; index += 1) {
    const key = `AW_DEPLOY_SECRET_${String(index).padStart(2, "0")}`;
    const value = environment[key] ?? "";
    if (value) addMask(value);
    values.push(value);
  }
  // Fail the entire batch before creating the directory or writing ANY value.
  // GitHub's best-effort job cleanup is not a substitute for an atomic preflight.
  for (const [index, entry] of secretEntries.entries()) {
    if (entry.required && !values[index]) {
      throw new CliError(`Required deploy Secret is unavailable: ${entry.name}.`, 77);
    }
  }
  const directory = join(runnerTemp, deploySecretDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staged: string[] = [];
  const createdPaths: string[] = [];
  try {
    for (const [index, entry] of secretEntries.entries()) {
      const value = values[index];
      if (!value) continue;
      const path = join(directory, entry.name);
      // Exclusive creation prevents replacing files that predate this attempt.
      const handle = await open(path, "wx", 0o600);
      // Ownership starts when open succeeds, before the first byte is written.
      // writeFile may partially write and throw; such a file must be removed.
      createdPaths.push(path);
      try {
        await handle.writeFile(value, { encoding: "utf8" });
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      staged.push(entry.name);
    }
    return staged;
  } catch (error) {
    // Never delete a pre-existing path: only undo files created by this attempt.
    // If cleanup itself fails, the workflow's unconditional cleanup is a backup.
    await Promise.allSettled(createdPaths.map((path) => rm(path, { force: true })));
    throw error;
  }
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  if (!runnerTemp) throw new CliError("RUNNER_TEMP is not set.", 64);
  const plan = JSON.parse(
    await readFile(join(runnerTemp, deploySecretPlanPath), "utf8")
  ) as SecretPlan;
  const staged = await stageDeploySecretSlots(process.env, plan, runnerTemp);
  console.log(`Product-scoped deployment Secrets staged: ${staged.length} authorized item(s).`);
}

if (isMain(import.meta.url)) main().catch(handleError);
