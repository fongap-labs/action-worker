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
  label?: "task" | "deploy";
  // Declared name -> the stored secret that supplies its value (see readSecretAliases).
  aliases?: ReadonlyMap<string, string>;
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

// A source declares the name its code reads (for example CLOUDFLARE_API_TOKEN). When one name serves
// several accounts, the central policy says which stored secret supplies the value for one task project
// or deploy environment: "aliases": { "CLOUDFLARE_API_TOKEN": "CLOUDFLARE_API_TOKEN_SECONDARY" }. The
// source code and its secret lists stay unchanged, and the stored secret of the declared name itself is
// never used for an aliased name.
export async function readSecretAliases(
  policyPath: string,
  kind: "task" | "deploy",
  repository: string,
  key: string
): Promise<ReadonlyMap<string, string>> {
  const policy: unknown = JSON.parse(await readFile(policyPath, "utf8"));
  const section = isJsonRecord(policy)
    ? policy[kind === "deploy" ? "deployments" : "tasks"]
    : undefined;
  const repositoryEntry =
    isJsonRecord(section) && Object.hasOwn(section, repository) ? section[repository] : undefined;
  const entry =
    isJsonRecord(repositoryEntry) && Object.hasOwn(repositoryEntry, key)
      ? repositoryEntry[key]
      : undefined;
  const aliases = new Map<string, string>();
  if (!isJsonRecord(entry) || entry.aliases === undefined) return aliases;
  if (!isJsonRecord(entry.aliases)) {
    throw new CliError(`Secret policy aliases are invalid: ${repository} ${key}.`, 65);
  }
  const declared = new Set([
    ...policyNames(entry.required, "required"),
    ...policyNames(entry.allowed, "allowed"),
  ]);
  const sources = new Set<string>();
  for (const [name, from] of Object.entries(entry.aliases)) {
    if (
      !envNamePattern.test(name) ||
      isReserved(name) ||
      typeof from !== "string" ||
      !envNamePattern.test(from) ||
      isReserved(from) ||
      from === name ||
      declared.has(from) ||
      sources.has(from) ||
      !declared.has(name)
    ) {
      throw new CliError(`Secret policy alias is invalid: ${name} in ${repository} ${key}.`, 65);
    }
    sources.add(from);
    aliases.set(name, from);
  }
  return aliases;
}

// Deploys use the same ceiling idea as tasks: `policies/deploy-secrets.json` lists, per repository and
// environment, every secret the target may declare. A name the target adds beyond it is reported
// (warn) or refused (enforce).
export async function readDeploySecretCeiling(
  policyPath: string,
  repository: string,
  environment: string
): Promise<ReadonlySet<string>> {
  const policy: unknown = JSON.parse(await readFile(policyPath, "utf8"));
  if (!isJsonRecord(policy) || policy.schema_version !== 1 || !isJsonRecord(policy.deployments)) {
    throw new CliError("Deploy secret policy is invalid.", 65);
  }
  const repositoryEntry = Object.hasOwn(policy.deployments, repository)
    ? policy.deployments[repository]
    : undefined;
  const environmentEntry =
    isJsonRecord(repositoryEntry) && Object.hasOwn(repositoryEntry, environment)
      ? repositoryEntry[environment]
      : undefined;
  if (!isJsonRecord(environmentEntry)) return new Set();
  return new Set([
    ...policyNames(environmentEntry.required, "required"),
    ...policyNames(environmentEntry.allowed, "allowed"),
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
): Promise<{
  allowed: string[];
  required: string[];
  unset: string[];
  policy_excess: string[];
  alias: Array<{ name: string; from: string }>;
}> {
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
      `Source declares secrets outside the central ${ceiling.label ?? "task"} secret policy: ${policyExcess.join(", ")}.`,
      65
    );
  }

  // An aliased name takes its value from the stored secret the policy names; the stored secret of the
  // declared name itself is not a fallback, because it may belong to another account.
  const aliases = ceiling?.aliases ?? new Map<string, string>();
  const alias: Array<{ name: string; from: string }> = [];
  const dropped: string[] = [];
  for (const name of [...allowed].sort()) {
    const from = aliases.get(name);
    if (from === undefined) continue;
    if (denied.has(from)) {
      throw new CliError(`Secret scope name is denied for this capability: ${from}.`, 65);
    }
    if (environment[from]) {
      alias.push({ name, from });
    } else {
      dropped.push(name);
    }
  }

  for (const name of required) {
    const from = aliases.get(name);
    if (from !== undefined ? !environment[from] : !environment[name]) {
      throw new CliError(
        `Required task secret is unavailable: ${name}${from === undefined ? "" : ` (stored as ${from})`}.`,
        77
      );
    }
  }

  const injected = Object.keys(environment)
    .filter((name) => !baseline.has(name))
    .sort();
  const unset = injected.filter(
    (name) => isReserved(name) || denied.has(name) || !allowed.has(name) || dropped.includes(name)
  );

  return {
    allowed: [...allowed].sort(),
    required: [...required].sort(),
    unset,
    policy_excess: policyExcess,
    alias,
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
    kind = "task",
  ] = process.argv.slice(2);
  if (!baselinePath) {
    throw new CliError(
      "Usage: resolve-secret-scope.ts <baseline> [required-file] [allowed-file] [denied-names] [secret-policy repository project-or-environment [task|deploy]]",
      64
    );
  }
  if (kind !== "task" && kind !== "deploy") {
    throw new CliError("The secret policy kind must be task or deploy.", 64);
  }
  const policyKind: "task" | "deploy" = kind === "deploy" ? "deploy" : "task";
  const modeVariable =
    kind === "deploy" ? "AW_DEPLOY_SECRET_POLICY_MODE" : "AW_TASK_SECRET_POLICY_MODE";
  const rawMode = process.env[modeVariable] || "warn";
  if (rawMode !== "warn" && rawMode !== "enforce") {
    throw new CliError(`${modeVariable} must be warn or enforce.`, 64);
  }
  const mode: TaskSecretPolicyMode = rawMode === "enforce" ? "enforce" : "warn";
  if (policyPath && (!repository || !project)) {
    throw new CliError(
      `A ${kind} secret policy needs a repository and ${kind === "deploy" ? "an environment" : "a project"}.`,
      64
    );
  }
  const ceiling = policyPath
    ? {
        names:
          kind === "deploy"
            ? await readDeploySecretCeiling(policyPath, repository, project)
            : await readTaskSecretCeiling(policyPath, repository, project),
        mode,
        label: policyKind,
        aliases: await readSecretAliases(policyPath, policyKind, repository, project),
      }
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
      `::warning::Source declares secrets outside the central ${kind} secret policy: ${scope.policy_excess.join(", ")}.`
    );
  }
  console.log(JSON.stringify(scope));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
