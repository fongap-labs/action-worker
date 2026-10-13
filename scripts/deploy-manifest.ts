import {
  assertUniqueEnvironments,
  isDeployPolicyKey,
  productPolicyKey,
} from "./deploy-policy-key.ts";
import { GithubReader, isJsonRecord } from "./github-api.ts";
import {
  isProductName,
  isRepositoryRelativePath,
  PRODUCTS_DIRECTORY,
  ROOT_MANIFEST_DIRECTORY,
} from "./product-discovery.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import { parseRunnerPolicy, resolveRunnerProfile } from "./runner-policy.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  readJson,
} from "./runtime-command.ts";

export type DeployAdapter = "source-script";

// schema 1: one environment for the whole repository. `automatic: true` is a push trigger on every
// path; `automatic: false` declares no trigger, so only a person can start the deploy.
export type DeployManifestV1 = {
  schema_version: "1";
  adapter: DeployAdapter;
  automatic: boolean;
  ignore_docs_only: boolean;
  runner_profile: string;
  environment: string;
  entrypoint: string;
};

export type DeployTriggerDeclaration = {
  push?: true | { paths: string[] };
  schedule?: string[];
};

// schema 2: several environments, each with its own triggers. The root is the product directory;
// a push trigger of `true` watches it.
export type DeployManifestV2 = {
  schema_version: "2";
  adapter: DeployAdapter;
  root: string;
  entrypoint: string;
  runner_profile: string;
  ignore_docs_only: boolean;
  environments: Record<string, { triggers?: DeployTriggerDeclaration }>;
};

export type DeployManifest = DeployManifestV1 | DeployManifestV2;

// The path pattern that matches every push, used for schema 1 and for `push: true` at the root.
export const wholeRepositoryPath = "**";

export type DeployEnvironmentPlan = {
  environment: string;
  // Path patterns of a push that starts an automatic deploy; null when only a person can start it.
  push_paths: readonly string[] | null;
  schedule: readonly string[];
  // True when a schema 2 manifest declares triggers for the environment. Only those environments are
  // checked for required reviewers, because schema 1 keeps its existing behavior.
  declares_triggers: boolean;
};

// Both schemas, converted to one structure organized by environment.
export type DeployPlan = {
  schema_version: "1" | "2";
  adapter: DeployAdapter;
  root: string;
  entrypoint: string;
  runner_profile: string;
  ignore_docs_only: boolean;
  environments: DeployEnvironmentPlan[];
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
const pathPattern = /^[A-Za-z0-9._/-]+$/;
const cronPattern = /^\S+( \S+){4}$/;
const rootDeployManifestPath = ".github/deploy.json";

export function isDeployEnvironmentName(value: string): boolean {
  return namePattern.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError("Deploy manifest keys are invalid.", 65);
  }
}

function safeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    pathPattern.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

// A trigger path is a repository-relative path, or a directory with a trailing /**. A bare "**" is
// not accepted here: a repository-wide trigger is `push: true` at the root.
function triggerPathValid(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const base = value.endsWith("/**") ? value.slice(0, -3) : value;
  return base !== "" && isRepositoryRelativePath(base);
}

export function decodeDeployManifestContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub deploy manifest response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

function parseSchemaOne(value: Record<string, unknown>): DeployManifestV1 {
  exactKeys(value, [
    "adapter",
    "automatic",
    "entrypoint",
    "environment",
    "ignore_docs_only",
    "runner_profile",
    "schema_version",
  ]);
  if (
    value.schema_version !== "1" ||
    value.adapter !== "source-script" ||
    typeof value.automatic !== "boolean" ||
    typeof value.ignore_docs_only !== "boolean" ||
    typeof value.runner_profile !== "string" ||
    !namePattern.test(value.runner_profile) ||
    typeof value.environment !== "string" ||
    !namePattern.test(value.environment) ||
    typeof value.entrypoint !== "string"
  ) {
    throw new CliError("Deploy manifest is invalid.", 65);
  }

  if (!safeRelativePath(value.entrypoint)) {
    throw new CliError("Source-script deploy manifest requires a safe relative entrypoint.", 65);
  }

  return value as DeployManifestV1;
}

function parseSchedule(value: unknown, environment: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 20 ||
    value.some((item) => typeof item !== "string" || !cronPattern.test(item))
  ) {
    throw new CliError(`Deploy schedule is invalid for environment ${environment}.`, 65);
  }
}

function parseTriggers(value: unknown, environment: string): void {
  const invalid = () =>
    new CliError(`Deploy triggers are invalid for environment ${environment}.`, 65);
  if (!isJsonRecord(value)) {
    throw invalid();
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== "push" && key !== "schedule")) {
    throw invalid();
  }
  if (value.push !== undefined) {
    const push = value.push;
    const isWhole = push === true;
    const isPaths =
      isJsonRecord(push) &&
      Object.keys(push).length === 1 &&
      Array.isArray(push.paths) &&
      push.paths.length > 0 &&
      push.paths.length <= 50 &&
      push.paths.every(triggerPathValid);
    if (!isWhole && !isPaths) {
      throw invalid();
    }
  }
  if (value.schedule !== undefined) {
    parseSchedule(value.schedule, environment);
  }
}

function parseSchemaTwo(value: Record<string, unknown>): DeployManifestV2 {
  exactKeys(value, [
    "adapter",
    "entrypoint",
    "environments",
    "ignore_docs_only",
    "root",
    "runner_profile",
    "schema_version",
  ]);
  const root = value.root;
  if (
    value.schema_version !== "2" ||
    value.adapter !== "source-script" ||
    typeof root !== "string" ||
    (root !== "" && !isRepositoryRelativePath(root)) ||
    typeof value.ignore_docs_only !== "boolean" ||
    typeof value.runner_profile !== "string" ||
    !namePattern.test(value.runner_profile) ||
    typeof value.entrypoint !== "string" ||
    !isJsonRecord(value.environments)
  ) {
    throw new CliError("Deploy manifest is invalid.", 65);
  }
  if (!safeRelativePath(value.entrypoint)) {
    throw new CliError("Source-script deploy manifest requires a safe relative entrypoint.", 65);
  }

  const names = Object.keys(value.environments);
  if (names.length === 0) {
    throw new CliError("Deploy manifest must declare at least one environment.", 65);
  }
  for (const [name, environment] of Object.entries(value.environments)) {
    if (!namePattern.test(name) || !isJsonRecord(environment)) {
      throw new CliError("Deploy manifest environment is invalid.", 65);
    }
    const keys = Object.keys(environment);
    if (keys.some((key) => key !== "triggers")) {
      throw new CliError(`Deploy manifest environment has unknown keys: ${name}.`, 65);
    }
    if (environment.triggers !== undefined) {
      parseTriggers(environment.triggers, name);
    }
  }
  return value as DeployManifestV2;
}

export function parseDeployManifest(value: unknown): DeployManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Deploy manifest must be an object.", 65);
  }
  return value.schema_version === "2" ? parseSchemaTwo(value) : parseSchemaOne(value);
}

// Converts either schema into the environment-organized plan. A root of "" in schema 2 and every
// schema 1 manifest watch the whole repository.
export function toDeployPlan(manifest: DeployManifest): DeployPlan {
  if (manifest.schema_version === "1") {
    return {
      schema_version: "1",
      adapter: manifest.adapter,
      root: "",
      entrypoint: manifest.entrypoint,
      runner_profile: manifest.runner_profile,
      ignore_docs_only: manifest.ignore_docs_only,
      environments: [
        {
          environment: manifest.environment,
          push_paths: manifest.automatic ? [wholeRepositoryPath] : null,
          schedule: [],
          declares_triggers: false,
        },
      ],
    };
  }

  return {
    schema_version: "2",
    adapter: manifest.adapter,
    root: manifest.root,
    entrypoint: manifest.entrypoint,
    runner_profile: manifest.runner_profile,
    ignore_docs_only: manifest.ignore_docs_only,
    environments: Object.entries(manifest.environments).map(([environment, declared]) => {
      const push = declared.triggers?.push;
      let pushPaths: readonly string[] | null = null;
      if (push === true) {
        pushPaths = manifest.root === "" ? [wholeRepositoryPath] : [`${manifest.root}/**`];
      } else if (push !== undefined) {
        pushPaths = [...push.paths];
      }
      return {
        environment,
        push_paths: pushPaths,
        schedule: [...(declared.triggers?.schedule ?? [])],
        declares_triggers: declared.triggers !== undefined,
      };
    }),
  };
}

export function parseDeployPlan(text: string, repository: string): DeployPlan {
  return toDeployPlan(
    parseDeployManifest(parseJson(text, `Deploy manifest must be valid JSON: ${repository}.`, 65))
  );
}

// Central authority over which environments a repository may deploy to. The target declares its
// environment in its deploy manifest, but that is a request: it is honoured only when this policy
// lists it, so a repository cannot name `production` (or another repository's environment) itself.
// A product is keyed as "owner/name/product"; the repository key stays for the root layout.
export type DeployEnvironmentPolicy = Record<string, readonly string[]>;

export function parseDeployEnvironmentPolicy(value: unknown): DeployEnvironmentPolicy {
  if (!isJsonRecord(value) || value.schema_version !== 1 || !isJsonRecord(value.repositories)) {
    throw new CliError("Deploy environment policy is invalid.", 65);
  }
  const policy: Record<string, string[]> = {};
  for (const [key, environments] of Object.entries(value.repositories)) {
    if (
      !isDeployPolicyKey(key) ||
      !Array.isArray(environments) ||
      environments.some((item) => typeof item !== "string" || !namePattern.test(item))
    ) {
      throw new CliError("Deploy environment policy entry is invalid.", 65);
    }
    policy[key] = [...(environments as string[])];
  }
  assertUniqueEnvironments(Object.entries(policy), "Deploy environment policy");
  return policy;
}

export function assertDeployEnvironmentAllowed(
  policy: DeployEnvironmentPolicy,
  key: string,
  environment: string
): void {
  const allowed = Object.hasOwn(policy, key) ? (policy[key] ?? []) : [];
  if (!allowed.includes(environment)) {
    // A product key has no fallback to the repository key, so the entry to add is spelled out.
    const isProductKey = key.split("/").length === 3;
    const hint = isProductKey
      ? ` Add this to policies/deploy-environments.json: "repositories": { "${key}": ["${environment}"] }.`
      : "";
    throw new CliError(
      `Deploy environment is not allowed for ${key}: ${environment}. Allowed: ${allowed.join(", ") || "none"}.${hint}`,
      77
    );
  }
}

export type DeploySelection = {
  // The product directory name under projects/. Empty selects the root layout (.github/).
  product?: string;
  // The environment declared by the manifest. Empty is allowed when the manifest declares one.
  environment?: string;
};

export type ResolvedDeployManifest = {
  schema_version: "1" | "2";
  repository: string;
  source_sha: string;
  product: string;
  product_directory: string;
  environment: string;
  adapter: DeployAdapter;
  automatic: boolean;
  push_paths: readonly string[] | null;
  declares_triggers: boolean;
  root: string;
  entrypoint: string;
  ignore_docs_only: boolean;
  runner_profile: string;
  runner_backend: string;
  trust_domain: string;
  runner_labels_json: string;
};

function selectEnvironment(plan: DeployPlan, requested: string): DeployEnvironmentPlan {
  const names = plan.environments.map((item) => item.environment).join(", ");
  if (requested !== "") {
    const match = plan.environments.find((item) => item.environment === requested);
    if (!match) {
      throw new CliError(
        `Deploy manifest does not declare environment ${requested}. Declared: ${names}.`,
        65
      );
    }
    return match;
  }
  const [only] = plan.environments;
  if (plan.environments.length === 1 && only !== undefined) {
    return only;
  }
  throw new CliError(
    `Deploy environment is required because the manifest declares several: ${names}.`,
    64
  );
}

export async function resolveDeployManifest(
  repository: string,
  sourceSha: string,
  repositoryPolicyValue: unknown,
  runnerPolicyValue: unknown,
  reader: { get(path: string): Promise<unknown> },
  environmentPolicyValue?: unknown,
  selection: DeploySelection = {}
): Promise<ResolvedDeployManifest> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(sourceSha)) {
    throw new CliError("Deploy manifest source identity is invalid.", 64);
  }
  validateRepositoryCapability(repository, repositoryPolicyValue, "deploy");

  const product = selection.product ?? "";
  if (product !== "" && !isProductName(product)) {
    throw new CliError(`Deploy product name is invalid: ${product}.`, 64);
  }
  // The root layout keeps its manifest in .github/; a product keeps it in its own directory.
  const productDirectory =
    product === "" ? ROOT_MANIFEST_DIRECTORY : `${PRODUCTS_DIRECTORY}/${product}`;
  const manifestPath = product === "" ? rootDeployManifestPath : `${productDirectory}/deploy.json`;
  const manifestResponse = await reader.get(
    `repos/${repository}/contents/${manifestPath}?ref=${sourceSha}`
  );
  const plan = parseDeployPlan(decodeDeployManifestContent(manifestResponse), repository);
  const environment = selectEnvironment(plan, selection.environment ?? "");

  if (environmentPolicyValue !== undefined) {
    assertDeployEnvironmentAllowed(
      parseDeployEnvironmentPolicy(environmentPolicyValue),
      productPolicyKey(repository, product),
      environment.environment
    );
  }
  const runnerPolicy = parseRunnerPolicy(runnerPolicyValue);
  const resolvedRunner = resolveRunnerProfile(runnerPolicy, plan.runner_profile);
  if (resolvedRunner.profile.trust_domain !== "privileged") {
    throw new CliError(
      `Deploy runner profile must use the privileged trust domain: ${plan.runner_profile}.`,
      77
    );
  }

  if (plan.entrypoint) {
    await reader.get(`repos/${repository}/contents/${plan.entrypoint}?ref=${sourceSha}`);
  }

  return {
    schema_version: plan.schema_version,
    repository,
    source_sha: sourceSha,
    product,
    product_directory: productDirectory,
    environment: environment.environment,
    adapter: plan.adapter,
    automatic: environment.push_paths !== null,
    push_paths: environment.push_paths,
    declares_triggers: environment.declares_triggers,
    root: plan.root,
    entrypoint: plan.entrypoint,
    ignore_docs_only: plan.ignore_docs_only,
    runner_profile: plan.runner_profile,
    runner_backend: resolvedRunner.profile.backend,
    trust_domain: resolvedRunner.profile.trust_domain,
    runner_labels_json: JSON.stringify(resolvedRunner.profile.labels),
  };
}

async function main(): Promise<void> {
  const [repository = "", sourceSha = "", runnerPolicyPath = "policies/runner.json"] =
    process.argv.slice(2);
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const rawRepositoryPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  if (!token || !rawRepositoryPolicy) {
    throw new CliError("AW_CONTROL_TOKEN and AW_REPOSITORY_POLICY are required.", 77);
  }

  const resolved = await resolveDeployManifest(
    repository,
    sourceSha,
    parseJson(rawRepositoryPolicy, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    await readJson(runnerPolicyPath),
    new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token)
  );

  await appendLines(process.env.GITHUB_OUTPUT, [
    `adapter=${resolved.adapter}`,
    `automatic=${resolved.automatic}`,
    `ignore_docs_only=${resolved.ignore_docs_only}`,
    `runner_profile=${resolved.runner_profile}`,
    `runner_backend=${resolved.runner_backend}`,
    `runner_labels_json=${resolved.runner_labels_json}`,
    `trust_domain=${resolved.trust_domain}`,
    `environment=${resolved.environment}`,
    `entrypoint=${resolved.entrypoint}`,
  ]);
  console.log(JSON.stringify(resolved));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
