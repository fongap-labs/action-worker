import {
  hasVerifiedControlStatus,
  type JsonReader,
  mainWriteGuardWorkflowPaths,
  postMergeRemediationStatusPrefix,
  trustedControlRunId,
} from "./ci-evidence.ts";
import {
  getGithubJsonIfExists,
  getJsonString,
  GithubHttpError,
  isJsonRecord,
} from "./github-api.ts";
import { assertNoOpenManagedWriteIncidents } from "./main-write-incidents.ts";
import { CliError } from "./runtime-command.ts";
import { latestAttestedStatus, originalStatusDescription } from "./status-attestation.ts";

export const branchAuthorizationWorkflow = ".github/workflows/authorize-branch-transfer.yml";
export const devBootstrapContext = "Dev Bootstrap Authorization";
export class DevBootstrapPendingError extends CliError {}
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const authorizationWindowMs = 24 * 60 * 60 * 1000;

export function bootstrapApprovalComment(
  repository: string,
  sha: string,
  runId: number,
  attempt: number
): string {
  if (
    !repositoryPattern.test(repository) ||
    !shaPattern.test(sha) ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  ) {
    throw new CliError("Invalid development initialization identity.", 65);
  }
  return `approve-dev-init ${runId}/${attempt} ${repository} ${sha}`;
}

export function isClosedDevProtection(value: unknown): boolean {
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
    value.conditions.ref_name.include[0] !== "refs/heads/dev" ||
    !Array.isArray(value.conditions.ref_name.exclude) ||
    value.conditions.ref_name.exclude.length !== 0 ||
    !Array.isArray(value.rules)
  ) {
    return false;
  }
  const types = value.rules.filter(isJsonRecord).map((rule) => rule.type);
  return ["creation", "deletion", "non_fast_forward", "update"].every((type) =>
    types.includes(type)
  );
}

export type DevProtectionMode = "native" | "compensating";

/** Only a confirmed private repository and explicit platform plan rejection qualify. */
export async function readClosedDevProtection(
  reader: JsonReader,
  repository: string,
  isPrivate: boolean
): Promise<DevProtectionMode> {
  let rules: unknown;
  try {
    rules = await reader.get(`repos/${repository}/rulesets?includes_parents=false&per_page=100`);
  } catch (error) {
    if (
      isPrivate &&
      error instanceof GithubHttpError &&
      error.status === 403 &&
      error.kind === "plan-restriction"
    ) {
      return "compensating";
    }
    throw error;
  }
  if (!Array.isArray(rules) || rules.length >= 100) {
    throw new CliError("Development rulesets unavailable.", 75);
  }
  const matches = rules.filter((rule) => getJsonString(rule, "name") === "Protect Dev Branch");
  const rule = matches[0];
  if (!isJsonRecord(rule) || matches.length !== 1 || !Number.isSafeInteger(rule.id)) {
    throw new CliError("Closed development ruleset is missing.", 75);
  }
  const detail = await reader.get(`repos/${repository}/rulesets/${rule.id}?includes_parents=false`);
  if (!isClosedDevProtection(detail)) {
    throw new CliError("Development initialization requires closed live protection.", 75);
  }
  return "native";
}

export async function verifyBootstrapSource(
  reader: JsonReader,
  repository: string,
  sha: string,
  controlRepository: string,
  isExistingDevRequired: boolean
): Promise<DevProtectionMode> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(sha)) {
    throw new CliError("Development initialization target is invalid.", 65);
  }
  const repo = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(repo) ||
    repo.full_name !== repository ||
    typeof repo.private !== "boolean" ||
    repo.default_branch !== "main"
  ) {
    throw new CliError("Development initialization requires a verified managed repository.", 75);
  }
  const protection = await readClosedDevProtection(reader, repository, repo.private);
  const main = await reader.get(`repos/${repository}/branches/main`);
  const dev = await getGithubJsonIfExists(`repos/${repository}/branches/dev`, (path) =>
    reader.get(path)
  );
  if (
    !isJsonRecord(main) ||
    getJsonString(main.commit, "sha") !== sha ||
    (isExistingDevRequired
      ? !isJsonRecord(dev) || getJsonString(dev.commit, "sha") !== sha
      : dev !== undefined)
  ) {
    throw new CliError("Development initialization branch identity changed.", 75);
  }
  await assertNoOpenManagedWriteIncidents(reader, repository, "main");
  await assertNoOpenManagedWriteIncidents(reader, repository, "dev");
  const statuses = await reader.get(`repos/${repository}/commits/${sha}/status`);
  const mainGuard = latestAttestedStatus(statuses, {
    repository,
    sha,
    context: "Main Write Guard",
  });
  if (
    !mainGuard ||
    originalStatusDescription(mainGuard).startsWith(postMergeRemediationStatusPrefix) ||
    !(await hasVerifiedControlStatus(reader, statuses, "Main Write Guard", {
      controlRepository,
      targetRepository: repository,
      targetSha: sha,
      workflowPaths: mainWriteGuardWorkflowPaths,
      runAttempts: 1,
    }))
  ) {
    throw new CliError("Development initialization requires a trusted current main SHA.", 75);
  }
  return protection;
}

export async function verifyAuthorizedDevBootstrap(
  reader: JsonReader,
  repository: string,
  sha: string,
  statuses: unknown,
  controlRepository: string,
  now = Date.now()
): Promise<string | undefined> {
  const receipt = latestAttestedStatus(statuses, {
    repository,
    sha,
    context: devBootstrapContext,
  });
  if (receipt?.state !== "success" || originalStatusDescription(receipt) !== `init-v1=${sha}`) {
    return undefined;
  }
  const createdAt = Date.parse(getJsonString(receipt, "created_at"));
  if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > authorizationWindowMs) {
    throw new CliError("Development initialization authorization expired.", 75);
  }
  const runId = trustedControlRunId(getJsonString(receipt, "target_url"), controlRepository);
  if (runId !== null) {
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    if (
      isJsonRecord(run) &&
      run.id === runId &&
      getJsonString(run.repository, "full_name") === controlRepository &&
      run.path === branchAuthorizationWorkflow &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      run.run_attempt === 1 &&
      run.status === "in_progress"
    ) {
      throw new DevBootstrapPendingError(
        "Development initialization publisher has not finished.",
        75
      );
    }
  }
  if (
    !(await hasVerifiedControlStatus(reader, statuses, devBootstrapContext, {
      controlRepository,
      targetRepository: repository,
      targetSha: sha,
      workflowPaths: [branchAuthorizationWorkflow],
      runAttempts: 1,
    }))
  ) {
    throw new CliError("Development initialization publisher is not verified.", 75);
  }
  await verifyBootstrapSource(reader, repository, sha, controlRepository, true);
  return `init-v1=${sha}`;
}

/** An existing, closed dev identical to trusted main needs no branch write or manual dispatch.
 * This never resolves incidents or overrides prior manual authorization evidence.
 */
export async function verifyAutomaticDevAdoption(
  reader: JsonReader,
  repository: string,
  sha: string,
  statuses: unknown,
  controlRepository: string
): Promise<string | undefined> {
  if (repository === controlRepository) return undefined;
  for (const context of [devBootstrapContext, "Dev Merge Receipt"]) {
    if (latestAttestedStatus(statuses, { repository, sha, context })) return undefined;
  }
  const main = await reader.get(`repos/${repository}/branches/main`);
  if (!isJsonRecord(main) || getJsonString(main.commit, "sha") !== sha) return undefined;
  const metadata = await reader.get(`repos/${repository}`);
  if (!isJsonRecord(metadata) || metadata.private !== false) return undefined;
  if ((await verifyBootstrapSource(reader, repository, sha, controlRepository, true)) !== "native") {
    return undefined;
  }
  const current = await reader.get(`repos/${repository}/branches/dev`);
  if (!isJsonRecord(current) || getJsonString(current.commit, "sha") !== sha) {
    throw new CliError("Development adoption branch identity changed.", 75);
  }
  return `init-v1=${sha}`;
}
