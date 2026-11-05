import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readDeploySecretVariableSources,
  resolveDeploySecretPlan,
} from "./resolve-secret-scope.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

export const deploySecretPlanPath = "action-worker-deploy-secret-plan.json";
export const deploySecretDirectory = "action-worker-deploy-secrets";
export const deploySecretSlots = 40;

async function main(): Promise<void> {
  const [
    requiredPath = "",
    allowedPath = "",
    policyPath = "",
    repository = "",
    environment = "",
    product = "",
  ] = process.argv.slice(2);
  if (!requiredPath || !allowedPath || !policyPath || !repository || !environment) {
    throw new CliError(
      "Usage: resolve-deploy-secret-plan.ts <required> <allowed> <policy> <repository> <environment> [product].",
      64
    );
  }
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  if (!runnerTemp) throw new CliError("RUNNER_TEMP is not set.", 64);
  const plan = await resolveDeploySecretPlan(
    requiredPath,
    allowedPath,
    policyPath,
    repository,
    environment,
    product,
    process.env
  );
  const variableSources = await readDeploySecretVariableSources(
    policyPath,
    repository,
    environment,
    product
  );
  const secretEntries = plan.filter((entry) => entry.kind === "secret");
  if (secretEntries.length > deploySecretSlots) {
    throw new CliError(
      `Deploy Secret plan exceeds the fixed slot limit of ${deploySecretSlots}.`,
      65
    );
  }
  const directory = join(runnerTemp, deploySecretDirectory);
  const path = join(runnerTemp, deploySecretPlanPath);
  await rm(directory, { recursive: true, force: true });
  await rm(path, { force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, JSON.stringify({ schema_version: 1, secrets: plan }), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(path, 0o600);
  const outputs = secretEntries.map(
    (entry, index) => `secret_${String(index).padStart(2, "0")}=${entry.source}`
  );
  for (let index = secretEntries.length; index < deploySecretSlots; index += 1) {
    outputs.push(`secret_${String(index).padStart(2, "0")}=`);
  }
  await appendLines(process.env.GITHUB_OUTPUT, outputs);
  console.log(
    `Deploy secret plan resolved: ${plan.length} authorized name(s), ${secretEntries.length} Secret slot(s), ${variableSources.size} Variable source(s); values not read.`
  );
}

if (isMain(import.meta.url)) main().catch(handleError);
