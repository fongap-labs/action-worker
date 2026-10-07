import { readFile } from "node:fs/promises";
import { isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const envNamePattern = /^[A-Z][A-Z0-9_]*$/;

function isReserved(name: string): boolean {
  return (
    /^(?:AW_|GITHUB_|RUNNER_|ACTIONS_)/.test(name) || name === "NODE_OPTIONS" || name === "GH_TOKEN"
  );
}

export type TaskSecretPolicyMode = "warn" | "enforce";

export type TaskSecretCeiling = {
  names: ReadonlySet<string>;
  mode: TaskSecretPolicyMode;
};

function policyNames(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CliError(`Task secret policy list is invalid: ${where}.`, 65);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !envNamePattern.test(item) || isReserved(item)) {
      throw new CliError(`Task secret policy name is invalid or reserved: ${where}.`, 65);
    }
    return item;
  });
}

// The central policy is a ceiling: a task source may declare fewer secrets than listed here, never more.
export async function readTaskSecretCeiling(
  policyPath: string,
  repository: string,
  project: string
): Promise<ReadonlySet<string>> {
  const policy: unknown = JSON.parse(await readFile(policyPath, "utf8"));
  if (!isJsonRecord(policy) || policy.schema_version !== 1 || !isJsonRecord(policy.tasks)) {
    throw new CliError("Task secret policy is invalid.", 65);
  }
  const repositoryEntry = policy.tasks[repository];
  const projectEntry = isJsonRecord(repositoryEntry) ? repositoryEntry[project] : undefined;
  if (!isJsonRecord(projectEntry)) return new Set();
  return new Set([
    ...policyNames(projectEntry.required, "required"),
    ...policyNames(projectEntry.allowed, "allowed"),
  ]);
}

async function readNames(path: string): Promise<Set<string>> {
  if (!path) return new Set();
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (!envNamePattern.test(line) || isReserved(line)) {
      throw new CliError(`Secret scope name is invalid or reserved: ${line}.`, 65);
    }
    names.add(line);
  }
  return names;
}

export async function resolveSecretScope(
  baselinePath: string,
  requiredPath: string,
  allowedPath: string,
  deniedNames: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
  ceiling?: TaskSecretCeiling
): Promise<{ allowed: string[]; required: string[]; unset: string[]; policy_excess: string[] }> {
  const baselineText = await readFile(baselinePath, "utf8");
  const baseline = new Set(
    baselineText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const required = await readNames(requiredPath);
  const optional = await readNames(allowedPath);
  const allowed = new Set([...required, ...optional]);
  const denied = new Set<string>();
  for (const raw of deniedNames) {
    const name = raw.trim();
    if (!name) continue;
    if (!envNamePattern.test(name)) {
      throw new CliError(`Denied secret scope name is invalid: ${name}.`, 65);
    }
    denied.add(name);
  }

  for (const name of allowed) {
    if (denied.has(name)) {
      throw new CliError(`Secret scope name is denied for this capability: ${name}.`, 65);
    }
  }

  const policyExcess = ceiling
    ? [...allowed].filter((name) => !ceiling.names.has(name)).sort()
    : [];
  if (ceiling?.mode === "enforce" && policyExcess.length > 0) {
    throw new CliError(
      `Task source declares secrets outside the central task secret policy: ${policyExcess.join(", ")}.`,
      65
    );
  }

  for (const name of required) {
    if (!environment[name]) {
      throw new CliError(`Required task secret is unavailable: ${name}.`, 77);
    }
  }

  const injected = Object.keys(environment)
    .filter((name) => !baseline.has(name))
    .sort();
  const unset = injected.filter(
    (name) => isReserved(name) || denied.has(name) || !allowed.has(name)
  );

  return {
    allowed: [...allowed].sort(),
    required: [...required].sort(),
    unset,
    policy_excess: policyExcess,
  };
}

async function main(): Promise<void> {
  const [
    baselinePath = "",
    requiredPath = "",
    allowedPath = "",
    deniedRaw = "",
    policyPath = "",
    repository = "",
    project = "",
  ] = process.argv.slice(2);
  if (!baselinePath) {
    throw new CliError(
      "Usage: resolve-secret-scope.ts <baseline> [required-file] [allowed-file] [denied-names] [task-secret-policy repository project]",
      64
    );
  }
  const rawMode = process.env.AW_TASK_SECRET_POLICY_MODE || "warn";
  if (rawMode !== "warn" && rawMode !== "enforce") {
    throw new CliError("AW_TASK_SECRET_POLICY_MODE must be warn or enforce.", 64);
  }
  const mode: TaskSecretPolicyMode = rawMode === "enforce" ? "enforce" : "warn";
  if (policyPath && (!repository || !project)) {
    throw new CliError("A task secret policy needs a repository and a project.", 64);
  }
  const ceiling = policyPath
    ? { names: await readTaskSecretCeiling(policyPath, repository, project), mode }
    : undefined;
  const deniedNames = deniedRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const scope = await resolveSecretScope(
    baselinePath,
    requiredPath,
    allowedPath,
    deniedNames,
    process.env,
    ceiling
  );
  if (scope.policy_excess.length > 0) {
    console.error(
      `::warning::Task source declares secrets outside the central task secret policy: ${scope.policy_excess.join(", ")}.`
    );
  }
  console.log(JSON.stringify(scope));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
