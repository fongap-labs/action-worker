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
const baseEnvironmentNames = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "RUNNER_TEMP",
  "DEPLOY_SOURCE_REPOSITORY",
  "DEPLOY_SOURCE_SHA",
  "DEPLOY_ENVIRONMENT",
  "DEPLOY_ENTRYPOINT",
  "DEPLOY_PRODUCT",
  "DEPLOY_PRODUCT_DIRECTORY",
  "DEPLOY_TRIGGER",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKSPACE",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "CI",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
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

function isOrdinaryVariable(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(?:AW_|GITHUB_|RUNNER_|ACTIONS_)/.test(name) &&
    name !== "NODE_OPTIONS" &&
    name !== "GH_TOKEN"
  );
}

export function buildScopedDeployEnvironment(
  base: NodeJS.ProcessEnv,
  plan: SecretPlan,
  secretValues: ReadonlyMap<string, string>,
  publicVariables: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  assertPlan(plan);
  const result: NodeJS.ProcessEnv = {};
  for (const name of baseEnvironmentNames) {
    if (base[name] !== undefined) result[name] = base[name];
  }
  for (const [name, value] of Object.entries(publicVariables)) {
    if (isOrdinaryVariable(name) && value !== undefined) result[name] = value;
  }
  for (const entry of plan.secrets) {
    const value =
      entry.kind === "variable" ? publicVariables[entry.source] : secretValues.get(entry.name);
    if (!value) {
      if (entry.required) {
        throw new CliError(`Required deploy ${entry.kind} is unavailable: ${entry.name}.`, 77);
      }
      delete result[entry.name];
      continue;
    }
    result[entry.name] = value;
    if (entry.source !== entry.name) delete result[entry.source];
  }
  return result;
}

export async function loadScopedSecretValues(
  directory: string,
  plan: SecretPlan
): Promise<Map<string, string>> {
  assertPlan(plan);
  const entries = plan.secrets.filter((entry) => entry.kind === "secret");
  const expected = new Set(entries.map((entry) => entry.name));
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
      throw new CliError(`Unexpected staged Secret file: ${file}.`, 65);
    }
  }
  const values = new Map<string, string>();
  for (const entry of entries) {
    try {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new CliError(`Unsafe staged Secret file: ${entry.name}.`, 65);
      }
      const value = await readFile(path, "utf8");
      if (value) values.set(entry.name, value);
      else if (entry.required) {
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

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const entrypoint = process.env.DEPLOY_ENTRYPOINT ?? "";
  if (!runnerTemp) throw new CliError("RUNNER_TEMP is not set.", 64);
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
    const values = await loadScopedSecretValues(secretDirectory, plan);
    const publicVariablePath = join(runnerTemp, "action-worker-repository-vars.json");
    const raw = JSON.parse(await readFile(publicVariablePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CliError("Repository Variable snapshot is invalid.", 65);
    }
    const publicVariables: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(raw)) {
      if (isOrdinaryVariable(name)) publicVariables[name] = textValue(value);
    }
    const env = buildScopedDeployEnvironment(process.env, plan, values, publicVariables);
    const target = resolve(process.cwd(), "target");
    const script = resolve(target, entrypoint);
    if (!script.startsWith(`${target}${sep}`)) {
      throw new CliError("Deploy entrypoint escapes source checkout.", 64);
    }
    const info = await lstat(script);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CliError("Deploy entrypoint is not a regular file.", 66);
    }
    await rm(secretDirectory, { recursive: true, force: true });
    await rm(planPath, { force: true });
    const child = spawnSync("bash", [entrypoint], {
      cwd: target,
      env,
      stdio: "inherit",
      shell: false,
    });
    if (child.error) throw new CliError("Deploy entrypoint could not start.", 1);
    process.exitCode = child.status ?? 1;
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
    await rm(planPath, { force: true });
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
