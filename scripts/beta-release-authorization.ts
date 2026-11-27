import { readFileSync } from "node:fs";
import { verifyCurrentBetaSource } from "./beta-source-proof.ts";
import type { JsonReader } from "./ci-evidence.ts";
import { getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import { hasRepositoryCapability } from "./repository-policy.ts";
import { CliError } from "./runtime-command.ts";

export function betaReleaseMode(policy: unknown): "closed" | "prepare" | "automatic" {
  if (
    !isJsonRecord(policy) ||
    policy.schema_version !== 1 ||
    Object.keys(policy).length !== 2 ||
    (policy.mode !== "closed" && policy.mode !== "prepare" && policy.mode !== "automatic")
  ) {
    throw new CliError("Invalid Beta release activation policy.", 65);
  }
  return policy.mode;
}

/** Derive eligibility from existing grants; no parallel list or cross-repository Beta publishing. */
export function betaReleaseCandidate(
  repository: string,
  repositoryPolicy: unknown,
  controlRepository: string
): boolean {
  return (
    /^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository) &&
    repository !== controlRepository &&
    hasRepositoryCapability(repository, repositoryPolicy, "pr") &&
    hasRepositoryCapability(repository, repositoryPolicy, "release-source") &&
    hasRepositoryCapability(repository, repositoryPolicy, "release-target")
  );
}

export function betaReleaseEnabled(
  policy: unknown,
  repository: string,
  repositoryPolicy: unknown,
  controlRepository: string
): boolean {
  return (
    betaReleaseMode(policy) === "automatic" &&
    betaReleaseCandidate(repository, repositoryPolicy, controlRepository)
  );
}

/** Formal tag protection reserves direct formal tag writes to the governed App. */
export function formalTagProtection(
  policy: unknown,
  repository: string,
  repositoryPolicy: unknown,
  controlRepository: string
) {
  if (
    betaReleaseMode(policy) === "closed" ||
    !betaReleaseCandidate(repository, repositoryPolicy, controlRepository)
  ) {
    return undefined;
  }
  return {
    name: "Protect Formal Tags",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/**"], exclude: ["refs/tags/*-v*-beta.*"] } },
    bypass_actors: [{ actor_type: "Integration", actor_id: 5609149, bypass_mode: "always" }],
    rules: ["creation", "update", "deletion"].map((type) => ({ type })),
  };
}

export function readBetaReleasePolicy(): unknown {
  return JSON.parse(
    readFileSync(new URL("../policies/beta-release-targets.json", import.meta.url), "utf8")
  ) as unknown;
}

/** GitHub App contents permissions are repository-wide. Require live protection for non-Beta tags. */
export function protectsFormalTags(value: unknown): boolean {
  if (
    !isJsonRecord(value) ||
    value.target !== "tag" ||
    value.enforcement !== "active" ||
    !isJsonRecord(value.conditions) ||
    !isJsonRecord(value.conditions.ref_name) ||
    JSON.stringify(value.conditions.ref_name.include) !== '["refs/tags/**"]' ||
    JSON.stringify(value.conditions.ref_name.exclude) !== '["refs/tags/*-v*-beta.*"]' ||
    !Array.isArray(value.rules) ||
    !Array.isArray(value.bypass_actors) ||
    value.bypass_actors.length !== 1
  ) {
    return false;
  }
  const actor = value.bypass_actors[0];
  if (
    !isJsonRecord(actor) ||
    actor.actor_type !== "Integration" ||
    actor.actor_id !== 5609149 ||
    actor.bypass_mode !== "always"
  ) {
    return false;
  }
  const types = value.rules.filter(isJsonRecord).map((rule) => rule.type);
  return ["creation", "update", "deletion"].every((type) => types.includes(type));
}

export function assertBetaProducer(
  request: unknown,
  run: unknown,
  controlRepository: string
): void {
  if (
    !isJsonRecord(request) ||
    request.source_branch !== "dev" ||
    request.artifact_repository !== controlRepository ||
    request.source_repository === controlRepository ||
    !isJsonRecord(run) ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    run.id !== request.artifact_run_id ||
    run.path !== ".github/workflows/release-app.yml" ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Number.isSafeInteger(run.run_attempt) ||
    request.request_id !== `release-build-${run.id}-${run.run_attempt}`
  ) {
    throw new CliError("Beta publication requires the exact successful central dev build.", 75);
  }
}

export async function verifyBetaReleaseSource(
  reader: JsonReader,
  repository: string,
  sha: string,
  controlRepository: string,
  policy: unknown,
  repositoryPolicy: unknown
): Promise<number> {
  if (!betaReleaseEnabled(policy, repository, repositoryPolicy, controlRepository)) {
    throw new CliError("Beta publication is disabled for this repository.", 75);
  }
  return verifyCurrentBetaSource(reader, repository, sha, controlRepository, () =>
    assertFormalTagProtection(reader, repository)
  );
}

/** Read the same live rule for preparation diagnostics and actual publication. */
export async function assertFormalTagProtection(
  reader: JsonReader,
  repository: string
): Promise<void> {
  const rules = getJsonArray(
    await reader.get(`repos/${repository}/rulesets?includes_parents=false&per_page=100`)
  ).filter((rule) => getJsonString(rule, "name") === "Protect Formal Tags");
  const rule = rules[0];
  if (
    rules.length !== 1 ||
    !isJsonRecord(rule) ||
    !Number.isSafeInteger(rule.id) ||
    !protectsFormalTags(
      await reader.get(`repos/${repository}/rulesets/${rule.id}?includes_parents=false`)
    )
  ) {
    throw new CliError("Beta publication requires live formal tag protection.", 75);
  }
}
