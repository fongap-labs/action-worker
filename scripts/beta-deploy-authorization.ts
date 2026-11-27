import { readFileSync } from "node:fs";
import { verifyCurrentBetaSource } from "./beta-source-proof.ts";
import type { JsonReader } from "./ci-evidence.ts";
import { isDeployPolicyKey, productPolicyKey } from "./deploy-policy-key.ts";
import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Binding = { source: string; kind: "secret" | "variable" };
export type BetaDeployTarget = {
  credential_environment: string;
  credentials: Record<string, Binding>;
  allow_schedule?: boolean;
  allow_push?: boolean;
};

export function readBetaDeployPolicy(): unknown {
  return JSON.parse(
    readFileSync(new URL("../policies/beta-deploy-targets.json", import.meta.url), "utf8")
  ) as unknown;
}

const reservedNames = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "IFS",
  "GH_TOKEN",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
]);

function safeName(name: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]{0,99}$/.test(name) &&
    !/^(?:AW_|GITHUB_|RUNNER_|ACTIONS_|DEPLOY_|BETA_|LD_|DYLD_|BASH_|GIT_|NODE_|NPM_CONFIG_)/.test(
      name
    ) &&
    !reservedNames.has(name)
  );
}

export function parseBetaDeployTargets(policy: unknown): Map<string, BetaDeployTarget> {
  if (
    !isJsonRecord(policy) ||
    policy.schema_version !== 1 ||
    !isJsonRecord(policy.targets) ||
    Object.keys(policy).length !== 2
  ) {
    throw new CliError("Invalid Beta deployment policy.", 65);
  }
  const targets = new Map<string, BetaDeployTarget>();
  const environments = new Set<string>();
  const sources = new Set<string>();
  for (const [key, target] of Object.entries(policy.targets)) {
    if (
      !isDeployPolicyKey(key) ||
      !key.startsWith("fongap-labs/") ||
      key.split("/")[1] === "action-worker" ||
      !isJsonRecord(target) ||
      Object.keys(target).some(
        (name) => !["credential_environment", "credentials", "allow_schedule", "allow_push"].includes(name)
      ) ||
      (target.allow_schedule !== undefined && typeof target.allow_schedule !== "boolean") ||
      (target.allow_push !== undefined && typeof target.allow_push !== "boolean") ||
      typeof target.credential_environment !== "string" ||
      !/^beta-[a-z0-9][a-z0-9-]{0,48}-ops$/.test(target.credential_environment) ||
      environments.has(target.credential_environment) ||
      !isJsonRecord(target.credentials)
    ) {
      throw new CliError("Invalid or shared Beta credential Environment.", 65);
    }
    environments.add(target.credential_environment);
    const prefix = target.credential_environment.toUpperCase().replaceAll("-", "_") + "_";
    const credentials: Record<string, Binding> = Object.create(null);
    for (const [name, binding] of Object.entries(target.credentials)) {
      if (
        !safeName(name) ||
        !isJsonRecord(binding) ||
        Object.keys(binding).length !== 2 ||
        typeof binding.source !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,99}$/.test(binding.source) ||
        !binding.source.startsWith(prefix) ||
        binding.source.length === prefix.length ||
        sources.has(binding.source) ||
        (binding.kind !== "secret" && binding.kind !== "variable")
      ) {
        throw new CliError("Invalid or shared Beta credential binding.", 65);
      }
      sources.add(binding.source);
      credentials[name] = { source: binding.source, kind: binding.kind };
    }
    targets.set(key, {
      credential_environment: target.credential_environment,
      credentials,
      ...(target.allow_schedule === undefined ? {} : { allow_schedule: target.allow_schedule }),
      ...(target.allow_push === undefined ? {} : { allow_push: target.allow_push }),
    });
  }
  return targets;
}

export function resolveBetaDeployTarget(
  policy: unknown,
  repository: string,
  product: string
): BetaDeployTarget {
  const selected = parseBetaDeployTargets(policy).get(productPolicyKey(repository, product));
  if (!selected) throw new CliError("Beta deployment is disabled for this product.", 77);
  return selected;
}

export function assertBetaDeployTrigger(
  target: BetaDeployTarget,
  trigger: string,
  manifest: { automatic: boolean; schedule: readonly string[] }
): void {
  if (
    (manifest.automatic && target.allow_push !== true) ||
    (manifest.schedule.length > 0 && target.allow_schedule !== true) ||
    (trigger !== "manual" &&
      !(trigger === "schedule" && target.allow_schedule === true && manifest.schedule.length > 0) &&
      !(trigger === "push" && target.allow_push === true && manifest.automatic))
  ) {
    throw new CliError("Beta deployment trigger is not centrally authorized.", 77);
  }
}

export function hasBetaPushGrant(
  targets: ReadonlyMap<string, BetaDeployTarget>,
  repository: string
): boolean {
  return [...targets].some(
    ([key, grant]) =>
      (key === repository || key.startsWith(repository + "/")) && grant.allow_push === true
  );
}

export function selectBetaDeployVariables(
  target: BetaDeployTarget,
  variables: Record<string, string>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const binding of Object.values(target.credentials)) {
    if (binding.kind === "variable" && Object.hasOwn(variables, binding.source)) {
      selected[binding.source] = variables[binding.source]!;
    }
  }
  return selected;
}

export function betaDeployCredentialPlan(
  target: BetaDeployTarget,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
  variables: NodeJS.ProcessEnv
): Array<Binding & { name: string; required: boolean }> {
  return [...new Set([...required, ...optional])].sort().map((name) => {
    const binding = target.credentials[name];
    if (!Object.hasOwn(target.credentials, name) || !binding) {
      throw new CliError(`Beta credential is not authorized: ${name}.`, 77);
    }
    if (binding.kind === "variable" && required.has(name) && !variables[binding.source]) {
      throw new CliError(`Required Beta variable is unavailable: ${name}.`, 77);
    }
    return { name, ...binding, required: required.has(name) };
  });
}

export async function verifyBetaDeploySource(
  reader: JsonReader,
  repository: string,
  sha: string,
  controlRepository: string
): Promise<number> {
  return verifyCurrentBetaSource(reader, repository, sha, controlRepository);
}
