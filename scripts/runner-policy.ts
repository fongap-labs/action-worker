import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

export const runnerBackends = ["github-hosted", "self-hosted"] as const;
export const runnerTrustDomains = ["sandbox", "control", "privileged"] as const;

export type RunnerBackend = typeof runnerBackends[number];
export type RunnerTrustDomain = typeof runnerTrustDomains[number];

export type RunnerProfile = {
  enabled: boolean;
  backend: RunnerBackend;
  trust_domain: RunnerTrustDomain;
  labels: string[];
  fallback_profiles: string[];
};

export type RunnerPolicy = {
  schema_version: 1;
  profiles: Record<string, RunnerProfile>;
};

const profilePattern = /^[a-z][a-z0-9-]{0,63}$/;
const labelPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const backendSet = new Set<string>(runnerBackends);
const trustSet = new Set<string>(runnerTrustDomains);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)
    || !value.every((item) => typeof item === "string" && labelPattern.test(item))
    || new Set(value).size !== value.length
  ) {
    throw new CliError(`${label} must be a unique runner label array.`, 65);
  }
  return value as string[];
}

function validateFallbackGraph(profiles: Record<string, RunnerProfile>): void {
  for (const [name, profile] of Object.entries(profiles)) {
    for (const fallback of profile.fallback_profiles) {
      const target = profiles[fallback];
      if (!target) {
        throw new CliError(`Runner fallback profile does not exist: ${name} -> ${fallback}.`, 65);
      }
      if (target.trust_domain !== profile.trust_domain) {
        throw new CliError(`Runner fallback cannot cross trust domains: ${name} -> ${fallback}.`, 65);
      }
    }
  }

  const states = new Map<string, number>();
  const visit = (name: string): void => {
    const state = states.get(name) ?? 0;
    if (state === 1) {
      throw new CliError(`Runner fallback cycle detected at profile: ${name}.`, 65);
    }
    if (state === 2) return;
    states.set(name, 1);
    for (const fallback of profiles[name]?.fallback_profiles ?? []) visit(fallback);
    states.set(name, 2);
  };
  for (const name of Object.keys(profiles)) visit(name);
}

export function parseRunnerPolicy(value: unknown): RunnerPolicy {
  if (!isJsonRecord(value)
    || value.schema_version !== 1
    || !isJsonRecord(value.profiles)
    || Object.keys(value.profiles).length === 0
  ) {
    throw new CliError("Runner Policy is invalid.", 65);
  }

  const profiles: Record<string, RunnerProfile> = {};
  for (const [name, raw] of Object.entries(value.profiles)) {
    if (!profilePattern.test(name)
      || !isJsonRecord(raw)
      || !exactKeys(raw, ["enabled", "backend", "trust_domain", "labels", "fallback_profiles"])
      || typeof raw.enabled !== "boolean"
      || typeof raw.backend !== "string" || !backendSet.has(raw.backend)
      || typeof raw.trust_domain !== "string" || !trustSet.has(raw.trust_domain)
    ) {
      throw new CliError(`Runner profile is invalid: ${name}.`, 65);
    }
    const labels = parseStringArray(raw.labels, `Runner profile labels: ${name}`);
    const fallbackProfiles = parseStringArray(raw.fallback_profiles, `Runner fallback profiles: ${name}`);
    if (raw.enabled && labels.length === 0) {
      throw new CliError(`Enabled runner profile has no labels: ${name}.`, 65);
    }
    if (fallbackProfiles.some((fallback) => !profilePattern.test(fallback) || fallback === name)) {
      throw new CliError(`Runner fallback profile is invalid: ${name}.`, 65);
    }
    profiles[name] = {
      enabled: raw.enabled,
      backend: raw.backend as RunnerBackend,
      trust_domain: raw.trust_domain as RunnerTrustDomain,
      labels,
      fallback_profiles: fallbackProfiles,
    };
  }

  validateFallbackGraph(profiles);
  return { schema_version: 1, profiles };
}

export function resolveRunnerProfile(
  policy: RunnerPolicy,
  requestedProfile: string,
): { name: string; profile: RunnerProfile } {
  if (!profilePattern.test(requestedProfile)) {
    throw new CliError(`Runner profile name is invalid: ${requestedProfile}.`, 64);
  }
  const start = policy.profiles[requestedProfile];
  if (!start) {
    throw new CliError(`Runner profile is not configured: ${requestedProfile}.`, 65);
  }

  const queue = [requestedProfile];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const profile = policy.profiles[name];
    if (profile?.enabled) {
      return { name, profile };
    }
    queue.push(...(profile?.fallback_profiles ?? []));
  }
  throw new CliError(`Runner profile has no enabled backend: ${requestedProfile}.`, 75);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let policyPath = "policies/runner.json";
  let requestedProfile = "";
  if (args.length === 1) {
    requestedProfile = args[0] ?? "";
  } else if (args.length === 2) {
    policyPath = args[0] ?? "";
    requestedProfile = args[1] ?? "";
  } else {
    throw new CliError("Usage: runner-policy.ts [policy-path] <runner-profile>", 64);
  }
  const policy = parseRunnerPolicy(await readJson(policyPath));
  const resolved = resolveRunnerProfile(policy, requestedProfile);
  console.log(JSON.stringify(resolved));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
