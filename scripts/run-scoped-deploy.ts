import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { deploySecretDirectory, deploySecretPlanPath } from "./resolve-deploy-secret-plan.ts";
import type { DeploySecretPlanEntry } from "./resolve-secret-scope.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

type SecretPlan = {
  schema_version: 1;
  secrets: DeploySecretPlanEntry[];
};

const namePattern = /^[A-Z][A-Z0-9_]*$/;
const controlEnvironmentNames = new Set([
  "AW_CONTROL_TOKEN",
  "AW_ADMIN_TOKEN",
  "AW_DISPATCH_TOKEN",
  "AW_CHECKOUT_TOKEN",
  "AW_APP_PRIVATE_KEY",
  "AW_STATUS_API_TOKEN",
  "AW_ISSUE_API_TOKEN",
  "AW_DISPATCH_API_TOKEN",
  "AW_STATUS_KEYRING",
  "AW_DEPLOY_SECRET_POLICY_MODE",
  "AW_DEPLOY_SECRET_VALUE",
  "AW_DEPLOY_SECRET_BUNDLE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  "NODE_OPTIONS",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STEP_SUMMARY",
]);

function assertPlan(plan: SecretPlan): void {
  if (plan.schema_version !== 1 || !Array.isArray(plan.secrets)) {
    throw new CliError("Deploy Secret plan is invalid.", 65);
  }
  const names = new Set<string>();
  const sources = new Set<string>();
  for (const entry of plan.secrets) {
    if (
      !entry ||
      !namePattern.test(entry.name) ||
      !namePattern.test(entry.source) ||
      typeof entry.required !== "boolean" ||
      !["secret", "variable"].includes(entry.kind) ||
      names.has(entry.name) ||
      sources.has(entry.source)
    ) {
      throw new CliError("Deploy Secret plan contains an invalid or duplicate entry.", 65);
    }
    names.add(entry.name);
    sources.add(entry.source);
  }
}

export function buildScopedDeployEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  plan: SecretPlan,
  secretValues: ReadonlyMap<string, string>
): NodeJS.ProcessEnv {
  assertPlan(plan);
  const environment: NodeJS.ProcessEnv = { ...baseEnvironment };
  for (const name of controlEnvironmentNames) {
    delete environment[name];
  }
  for (const entry of plan.secrets) {
    delete environment[entry.name];
    const value = entry.kind === "variable" ? baseEnvironment[entry.source] : secretValues.get(entry.name);
    if (!value) {
      if (entry.required) {
        throw new CliError(
          `Required deploy ${entry.kind} is unavailable: ${entry.name} (source ${entry.source}).`,
          77
        );
      }
    } else {
      environment[entry.name] = value;
    }
    if (entry.source !== entry.name) {
      delete environment[entry.source];
    }
  }
  return environment;
}

export async function loadScopedSecretValues(
  directory: string,
  plan: SecretPlan
): Promise<Map<string, string>> {
  assertPlan(plan);
  const expected = new Set(plan.secrets.filter((entry) => entry.kind === "secret").map((entry) => entry.name));
  let files: string[] = [];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  for (const file of files) {
    if (!expected.has(file)) {
      throw new CliError(`Unexpected file in deploy Secret staging directory: ${file}.`, 65);
    }
  }
  const values = new Map<string, string>();
  for (const entry of plan.secrets.filter((item) => item.kind === "secret")) {
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new CliError(`Deploy Secret staging file permissions are unsafe: ${entry.name}.`, 65);
      }
      const value = await readFile(path, "utf8");
      if (value.length > 0) {
        values.set(entry.name, value);
      } else if (entry.required) {
        throw new CliError(`Required deploy Secret is empty: ${entry.name}.`, 77);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        if (entry.required) {
          throw new CliError(`Required deploy Secret is unavailable: ${entry.name}.`, 77);
        }
      } else {
        throw error;
      }
    }
  }
  return values;
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const entrypoint = process.env.DEPLOY_ENTRYPOINT ?? "";
  if (!runnerTemp) {
    throw new CliError("RUNNER_TEMP is not set.", 64);
  }
  if (
    !/^[A-Za-z0-9._/-]+$/.test(entrypoint) ||
    entrypoint.startsWith("/") ||
    entrypoint.split("/").includes("..")
  ) {
    throw new CliError("Deploy entrypoint path is invalid.", 64);
  }
  const planPath = join(runnerTemp, deploySecretPlanPath);
  const secretDirectory = join(runnerTemp, deploySecretDirectory);
  try {
    const plan = JSON.parse(await readFile(planPath, "utf8")) as SecretPlan;
    assertPlan(plan);
    const secretValues = await loadScopedSecretValues(secretDirectory, plan);
    const childEnvironment = buildScopedDeployEnvironment(process.env, plan, secretValues);
    const targetDirectory = resolve(process.cwd(), "target");
    const targetEntrypoint = resolve(targetDirectory, entrypoint);
    if (!targetEntrypoint.startsWith(`${targetDirectory}${sep}`)) {
      throw new CliError("Deploy entrypoint escapes the source checkout.", 64);
    }
    const info = await lstat(targetEntrypoint);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CliError("Deploy entrypoint is not a regular file.", 66);
    }
    // Remove staged values before launching source-owned code; only the child environment carries them.
    await rm(secretDirectory, { recursive: true, force: true });
    await rm(planPath, { force: true });
    const result = spawnSync("bash", [entrypoint], {
      cwd: targetDirectory,
      env: childEnvironment,
      stdio: "inherit",
      shell: false,
    });
    if (result.error) {
      const code = "code" in result.error ? String(result.error.code) : "unknown";
      console.error(`Deploy entrypoint could not start (${code}).`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
    await rm(planPath, { force: true });
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
