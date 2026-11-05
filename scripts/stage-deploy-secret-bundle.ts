import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const directory = join(runnerTemp, deploySecretDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staged: string[] = [];
  for (const [index, entry] of secretEntries.entries()) {
    const value = values[index];
    if (!value) {
      if (entry.required) {
        throw new CliError(`Required deploy Secret is unavailable: ${entry.name}.`, 77);
      }
      continue;
    }
    const path = join(directory, entry.name);
    await writeFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
    staged.push(entry.name);
  }
  return staged;
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
