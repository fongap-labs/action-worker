import { parseBetaDeployTargets, readBetaDeployPolicy } from "./beta-deploy-authorization.ts";
import {
  assertFormalTagProtection,
  betaReleaseCandidate,
  betaReleaseMode,
  readBetaReleasePolicy,
} from "./beta-release-authorization.ts";
import type { JsonReader } from "./ci-evidence.ts";
import { getJsonArray, getJsonString, GithubReader, isJsonRecord } from "./github-api.ts";
import { hasRepositoryCapability, readRepositoryPolicyText } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { assertExistingCredentialEnvironment } from "./verify-deploy-credential-environment.ts";

export type Readiness = { subject: string; ready: boolean; reason: string };

export async function planBetaReleaseReadiness(
  reader: JsonReader,
  repository: string,
  control: string,
  grants: unknown,
  policy: unknown,
  appConfigured: boolean
): Promise<{ probe: boolean; result?: Readiness }> {
  const mode = betaReleaseMode(policy);
  if (mode === "closed" || !betaReleaseCandidate(repository, grants, control)) {
    return { probe: false };
  }
  const repo = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(repo) ||
    repo.full_name !== repository ||
    repo.private !== false ||
    repo.default_branch !== "main"
  ) {
    return { probe: false };
  }
  try {
    await assertFormalTagProtection(reader, repository);
  } catch {
    return {
      probe: false,
      result: { subject: repository, ready: false, reason: "Formal tag protection unverified" },
    };
  }
  if (!appConfigured) {
    return {
      probe: false,
      result: { subject: repository, ready: false, reason: "Independent Beta App not configured" },
    };
  }
  return { probe: true };
}

async function environmentNames(
  reader: JsonReader,
  prefix: string,
  kind: "secrets" | "variables"
): Promise<Set<string>> {
  const names = new Set<string>();
  for (let page = 1; page <= 20; page += 1) {
    const response = await reader.get(`${prefix}/${kind}?per_page=100&page=${page}`);
    const items = getJsonArray(response, kind);
    if (items.length > 100) throw new CliError("Invalid environment inventory.", 65);
    for (const item of items) {
      const name = getJsonString(item, "name");
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        throw new CliError("Invalid environment inventory name.", 65);
      }
      names.add(name);
    }
    if (items.length < 100) return names;
  }
  throw new CliError("Environment inventory exceeds verification limit.", 75);
}

/** Inventory checks use only names; they never prove runtime credential values or deployment. */
export async function auditBetaDeployReadiness(
  reader: JsonReader,
  control: string,
  grants: unknown,
  policy: unknown
): Promise<Readiness[]> {
  const results: Readiness[] = [];
  for (const [key, target] of parseBetaDeployTargets(policy)) {
    const repository = key.split("/").slice(0, 2).join("/");
    let reason = "";
    if (!hasRepositoryCapability(repository, grants, "deploy")) {
      reason = "Missing repository deploy grant";
    } else {
      try {
        const repo = await reader.get(`repos/${repository}`);
        if (
          !isJsonRecord(repo) ||
          repo.full_name !== repository ||
          repo.private !== false ||
          repo.default_branch !== "main"
        ) {
          throw new CliError("Source eligibility unverified.", 77);
        }
        await assertExistingCredentialEnvironment(reader, control, target.credential_environment);
        const prefix = `repos/${control}/environments/${target.credential_environment}`;
        const bindings = Object.values(target.credentials);
        const secrets = bindings.some((binding) => binding.kind === "secret")
          ? await environmentNames(reader, prefix, "secrets")
          : new Set<string>();
        const variables = bindings.some((binding) => binding.kind === "variable")
          ? await environmentNames(reader, prefix, "variables")
          : new Set<string>();
        if (
          bindings.some(
            (binding) => !(binding.kind === "secret" ? secrets : variables).has(binding.source)
          )
        ) {
          reason = "One or more credential names missing from dedicated Environment";
        }
      } catch {
        reason = "Beta source, Environment or credential inventory unverified";
      }
    }
    results.push({
      subject: key,
      ready: reason === "",
      reason: reason || "Dedicated Environment and configured credential names verified",
    });
  }
  return results;
}

async function report(result: Readiness): Promise<void> {
  const line = `- ${result.subject}: ${result.ready ? "READY FOR TEST" : "NOT READY"} - ${result.reason}`;
  console.log(line);
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [line]);
}

async function main(): Promise<void> {
  const control = process.env.GITHUB_REPOSITORY ?? "";
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    control !== "fongap-labs/action-worker"
  ) {
    throw new CliError("Beta readiness audit requires trusted central Actions.", 77);
  }
  const command = process.argv[2];
  const repository = process.env.TARGET_REPOSITORY ?? "";
  const token = process.env.GH_TOKEN ?? "";
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const grants: unknown = JSON.parse(readRepositoryPolicyText());
  const policy = readBetaReleasePolicy();
  if (command === "release-plan") {
    if (!token) throw new CliError("Beta readiness metadata reader is unavailable.", 77);
    const plan = await planBetaReleaseReadiness(
      reader,
      repository,
      control,
      grants,
      policy,
      process.env.BETA_APP_CONFIGURED === "true"
    );
    await appendLines(process.env.GITHUB_OUTPUT, [
      `probe=${plan.probe}`,
      `repository_name=${plan.probe ? repository.split("/")[1] : ""}`,
    ]);
    if (plan.result) {
      await report(plan.result);
      if (betaReleaseMode(policy) === "automatic") {
        throw new CliError("Enabled Beta release is not ready.", 77);
      }
    }
    return;
  }
  if (command === "release-probe") {
    if (!betaReleaseCandidate(repository, grants, control)) {
      throw new CliError("Beta release probe exceeds the repository policy.", 77);
    }
    let ready = false;
    try {
      if (token) {
        const repo = await reader.get(`repos/${repository}`);
        ready = getJsonString(repo, "full_name") === repository;
      }
    } catch {
      // Do not log credentials, response bodies or token mint diagnostics here.
    }
    await report({
      subject: repository,
      ready,
      reason: ready
        ? "Independent scoped contents-write token minted; no release or tag written"
        : "Independent Beta App token could not be verified",
    });
    if (!ready && betaReleaseMode(policy) === "automatic") {
      throw new CliError("Enabled Beta release is not ready.", 77);
    }
    return;
  }
  if (command === "deploy") {
    if (!token) throw new CliError("Beta readiness metadata reader is unavailable.", 77);
    const results = await auditBetaDeployReadiness(reader, control, grants, readBetaDeployPolicy());
    if (!results.length) {
      await report({ subject: "Beta deployment", ready: false, reason: "No authorized targets" });
      return;
    }
    for (const result of results) await report(result);
    if (results.some((result) => !result.ready)) {
      throw new CliError("Configured Beta deployment targets are not ready.", 77);
    }
    return;
  }
  throw new CliError("Unknown Beta readiness audit command.", 64);
}

if (isMain(import.meta.url)) main().catch(handleError);
