import { readFileSync } from "node:fs";
import type { JsonReader } from "./ci-evidence.ts";
import { isDeployPolicyKey, productPolicyKey } from "./deploy-policy-key.ts";
import { assertTrustedDevWrite, verifyRecordedDevWrite } from "./dev-write-guard.ts";
import { getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Binding = { source: string; kind: "secret" | "variable" };
export type BetaDeployTarget = {
  credential_environment: string;
  credentials: Record<string, Binding>;
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

export function resolveBetaDeployTarget(
  policy: unknown,
  repository: string,
  product: string
): BetaDeployTarget {
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
      Object.keys(target).length !== 2 ||
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
    targets.set(key, { credential_environment: target.credential_environment, credentials });
  }
  const selected = targets.get(productPolicyKey(repository, product));
  if (!selected) throw new CliError("Beta deployment is disabled for this product.", 77);
  return selected;
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
  const source = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(source) ||
    source.private !== false ||
    source.full_name !== repository ||
    source.default_branch !== "main" ||
    repository === controlRepository
  ) {
    throw new CliError("Beta deploy requires a public managed source.", 75);
  }
  await assertTrustedDevWrite(reader, repository, sha, controlRepository);
  const proof = await verifyRecordedDevWrite(reader, repository, sha, controlRepository);
  const live = await reader.get(`repos/${repository}/commits/dev`);
  if (getJsonString(live, "sha") !== sha) {
    throw new CliError("Beta deployment source is no longer current dev HEAD.", 75);
  }
  return proof.scope.prNumber;
}
