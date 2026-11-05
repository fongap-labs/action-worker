import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeploySecretPlanEntry } from "./resolve-secret-scope.ts";
import { deploySecretDirectory, deploySecretPlanPath } from "./resolve-deploy-secret-plan.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

type SecretPlan = { schema_version: 1; secrets: DeploySecretPlanEntry[] };
const namePattern = /^[A-Z][A-Z0-9_]*$/;

export async function stageDeploySecretValue(source: string, value: string, plan: SecretPlan, runnerTemp: string): Promise<boolean> {
  if (!namePattern.test(source)) throw new CliError("Deploy Secret source name is invalid.", 64);
  const matches = plan.secrets.filter((entry) => entry.kind === "secret" && entry.source === source);
  if (matches.length !== 1) throw new CliError(`Deploy Secret source is not in the approved plan: ${source}.`, 65);
  const entry = matches[0];
  if (!entry) throw new CliError("Deploy Secret plan entry is missing.", 65);
  if (value.length === 0) {
    if (entry.required) throw new CliError(`Required deploy Secret is unavailable: ${entry.name} (stored as ${source}).`, 77);
    return false;
  }
  const directory = join(runnerTemp, deploySecretDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, entry.name);
  await writeFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return true;
}

async function main(): Promise<void> {
  const [source = ""] = process.argv.slice(2);
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const value = process.env.AW_DEPLOY_SECRET_VALUE ?? "";
  if (!runnerTemp) throw new CliError("RUNNER_TEMP is not set.", 64);
  const path = join(runnerTemp, deploySecretPlanPath);
  const plan = JSON.parse(await readFile(path, "utf8")) as SecretPlan;
  if (plan.schema_version !== 1 || !Array.isArray(plan.secrets)) throw new CliError("Deploy Secret plan is invalid.", 65);
  const staged = await stageDeploySecretValue(source, value, plan, runnerTemp);
  if (staged) console.log(`Scoped deploy Secret staged: ${plan.secrets.find((entry) => entry.source === source)?.name ?? source}.`);
}

if (isMain(import.meta.url)) main().catch(handleError);
