import { readFileSync } from "node:fs";
import { managedRepositoryRulesets } from "./apply-repository-settings.ts";
import { type JsonReader, latestCiStatus } from "./ci-evidence.ts";
import { type PrCiScope, prCiScopeDescription } from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import { verifyDevMergeAdmission, verifyDevSquashCommit } from "./dev-merge-admission.ts";
import { assertTrustedDevWrite, devMergeReceiptContext } from "./dev-write-guard.ts";
import {
  GithubHttpError,
  getJsonArray,
  getJsonString,
  isJsonRecord,
  statusAwareReader,
} from "./github-api.ts";
import { squashManagedPull } from "./managed-pr-squash.ts";
import { hasApprovedPrivateCiCaller } from "./private-ci-evidence.ts";
import { takeProtectionReadToken, withProtectionReads } from "./protection-read-scope.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

const appId = 5609149;
const shaPattern = /^[0-9a-f]{40}$/;

/** The central ruleset, not an environment flag or a dispatch payload, controls activation. */
export function protectedMergeRuleset(
  value: unknown,
  branch: "main" | "dev",
  isController = false
): boolean {
  if (
    !isJsonRecord(value) ||
    value.target !== "branch" ||
    value.enforcement !== "active" ||
    !Array.isArray(value.bypass_actors) ||
    value.bypass_actors.length !== 0 ||
    !isJsonRecord(value.conditions) ||
    !isJsonRecord(value.conditions.ref_name) ||
    !Array.isArray(value.conditions.ref_name.include) ||
    value.conditions.ref_name.include.length !== 1 ||
    value.conditions.ref_name.include[0] !== `refs/heads/${branch}` ||
    !Array.isArray(value.conditions.ref_name.exclude) ||
    value.conditions.ref_name.exclude.length !== 0 ||
    !Array.isArray(value.rules)
  ) {
    return false;
  }
  const rules = value.rules.filter(isJsonRecord);
  if (rules.some((rule) => rule.type === "update")) return false;
  if (branch === "dev" && !rules.some((rule) => rule.type === "creation")) return false;
  for (const type of ["deletion", "non_fast_forward", "required_linear_history"]) {
    if (!rules.some((rule) => rule.type === type)) return false;
  }
  const pr = rules.find((rule) => rule.type === "pull_request")?.parameters;
  const checks = rules.find((rule) => rule.type === "required_status_checks")?.parameters;
  const context = branch === "dev" ? "validate-merge-dev" : "validate-merge";
  const integrationId = branch === "main" && isController ? 15368 : appId;
  return (
    isJsonRecord(pr) &&
    Array.isArray(pr.allowed_merge_methods) &&
    pr.allowed_merge_methods.length === 1 &&
    pr.allowed_merge_methods[0] === "squash" &&
    isJsonRecord(checks) &&
    checks.strict_required_status_checks_policy === true &&
    Array.isArray(checks.required_status_checks) &&
    checks.required_status_checks.some(
      (check) =>
        isJsonRecord(check) && check.context === context && check.integration_id === integrationId
    )
  );
}

export function devMergePolicyEnabled(
  policy: unknown,
  repository: string,
  controlRepository: string
): boolean {
  const rulesets = managedRepositoryRulesets(policy, repository, controlRepository);
  return (
    protectedMergeRuleset(
      rulesets.find((rule) => rule.name === "Protect Dev Branch"),
      "dev"
    ) &&
    protectedMergeRuleset(
      rulesets.find((rule) => rule.name === "Protect Main Branch"),
      "main",
      repository === controlRepository
    )
  );
}

export async function requireLiveProtection(
  reader: JsonReader,
  repository: string,
  controlRepository: string,
  isPrivate = false
): Promise<void> {
  let listing: unknown;
  try {
    listing = await reader.get(`repos/${repository}/rulesets?includes_parents=false&per_page=100`);
  } catch (error) {
    if (
      isPrivate &&
      error instanceof GithubHttpError &&
      error.status === 403 &&
      error.kind === "plan-restriction"
    ) {
      console.warn(
        "Private native protection unavailable; central signed admission and write audit remain required."
      );
      return;
    }
    throw error;
  }
  const rulesets = getJsonArray(listing);
  for (const branch of ["main", "dev"] as const) {
    const name = branch === "main" ? "Protect Main Branch" : "Protect Dev Branch";
    const candidates = rulesets.filter((rule) => getJsonString(rule, "name") === name);
    const rule = candidates[0];
    if (!isJsonRecord(rule) || candidates.length !== 1 || !Number.isSafeInteger(rule.id)) {
      throw new CliError("Required live branch protection is missing.", 75);
    }
    const detail = await reader.get(
      `repos/${repository}/rulesets/${rule.id}?includes_parents=false`
    );
    if (!protectedMergeRuleset(detail, branch, repository === controlRepository)) {
      throw new CliError("Live branch protection does not match the reviewed merge boundary.", 75);
    }
  }
}

type Identity = {
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  runUrl: string;
  controlRepository: string;
};

export async function authorizeDevMerge(
  reader: JsonReader,
  policy: unknown,
  identity: Identity
): Promise<PrCiScope | undefined> {
  if (!devMergePolicyEnabled(policy, identity.repository, identity.controlRepository)) {
    return undefined;
  }
  const { repository, prNumber, headSha, baseSha, runUrl, controlRepository } = identity;
  const source = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(source) ||
    typeof source.private !== "boolean" ||
    source.default_branch !== "main" ||
    source.full_name !== repository
  ) {
    throw new CliError("Dev merge requires a managed repository with known visibility.", 75);
  }
  if (source.private && !(await hasApprovedPrivateCiCaller(reader, repository, baseSha))) {
    throw new CliError("Private dev merge requires an approved source-owned CI caller.", 75);
  }
  await requireLiveProtection(reader, repository, controlRepository, source.private);
  // The first dev baseline requires its own reviewed authorization. No implicit main trust.
  await assertTrustedDevWrite(reader, repository, baseSha, controlRepository);
  const scope = await verifyDevMergeAdmission(
    reader,
    repository,
    prNumber,
    headSha,
    baseSha,
    runUrl,
    controlRepository
  );
  const statuses = await reader.get(`repos/${repository}/commits/${headSha}/status`);
  if (latestCiStatus(statuses, "validate-merge")?.state === "success") {
    throw new CliError("Dev merge head also carries a main merge success.", 75);
  }
  return scope;
}

/** One ordinary PR merge, never a direct branch update or an admin/bypass merge. */
export async function executeDevMerge(
  reader: JsonReader,
  policy: unknown,
  identity: Identity,
  merge: (scope: PrCiScope) => Promise<unknown>,
  record: (scope: PrCiScope, writeSha: string) => Promise<void>
): Promise<void> {
  const scope = await authorizeDevMerge(reader, policy, identity);
  if (!scope) throw new CliError("Dev merge execution is disabled by central policy.", 75);
  const current = await verifyDevMergeAdmission(
    reader,
    scope.repository,
    scope.prNumber,
    scope.headSha,
    scope.baseSha,
    identity.runUrl,
    identity.controlRepository
  );
  if (prCiScopeDescription(current) !== prCiScopeDescription(scope)) {
    throw new CliError("Dev merge scope changed before execution.", 75);
  }
  const result = await merge(scope);
  const writeSha = getJsonString(result, "sha");
  if (!isJsonRecord(result) || result.merged !== true || !shaPattern.test(writeSha)) {
    throw new CliError("GitHub did not confirm the development squash merge.", 75);
  }
  await verifyDevSquashCommit(reader, scope, writeSha);
  await record(scope, writeSha);
}

async function main(): Promise<void> {
  const protectionToken = takeProtectionReadToken();
  const stage = process.argv[2];
  const identity = {
    repository: process.env.REPOSITORY ?? "",
    prNumber: Number(process.env.PR_NUMBER ?? ""),
    headSha: process.env.HEAD_SHA ?? "",
    baseSha: process.env.BASE_SHA ?? "",
    runUrl: process.env.RUN_URL ?? "",
    controlRepository: process.env.GITHUB_REPOSITORY ?? "",
  };
  validateRepositoryCapability(identity.repository, JSON.parse(readRepositoryPolicyText()), "pr");
  const policy: unknown = JSON.parse(readFileSync("policies/rulesets.json", "utf8"));
  const reader = withProtectionReads(
    statusAwareReader(
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      requireToken("control"),
      requireToken("status")
    ),
    protectionToken,
    [identity.repository]
  );
  if (stage === "authorize") {
    const scope = await authorizeDevMerge(reader, policy, identity);
    if (!scope) {
      console.log(
        "::warning::Dev merge is disabled by central policy; review repository capability and protection."
      );
    }
    await appendLines(process.env.GITHUB_OUTPUT, [`enabled=${Boolean(scope)}`]);
    return;
  }
  if (
    stage !== "execute" ||
    !devMergePolicyEnabled(policy, identity.repository, identity.controlRepository)
  ) {
    throw new CliError("Dev merge execution is not authorized.", 75);
  }
  const writeToken = process.env.AW_MERGE_WRITE_TOKEN ?? "";
  if (!writeToken) throw new CliError("Scoped development merge token required.", 77);
  await executeDevMerge(
    reader,
    policy,
    identity,
    (scope) => squashManagedPull(scope.repository, scope.prNumber, scope.headSha, writeToken),
    async (scope, sha) => {
      const status = {
        repository: scope.repository,
        sha,
        state: "success" as const,
        context: devMergeReceiptContext,
        description: `merge-v1=${scope.mergeSha}`,
        targetUrl: identity.runUrl,
      };
      await postGithubCommitStatus({
        ...status,
        token: requireToken("status"),
        description: signedStatusDescription(status),
      });
    }
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
