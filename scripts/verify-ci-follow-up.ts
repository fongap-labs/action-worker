import { hasVerifiedCiEvidence, latestCiStatus, trustedControlRunId } from "./ci-evidence.ts";
import { GithubReader, getJsonString, isJsonRecord } from "./github-api.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

export type FollowUpRequest = {
  repository: string;
  head_sha: string;
  pr_number: number;
  ci_run_id: number;
};

export function parseFollowUpRequest(value: unknown): FollowUpRequest {
  if (
    !isJsonRecord(value) ||
    Object.keys(value).sort().join(",") !== "ci_run_id,head_sha,pr_number,repository" ||
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    typeof value.head_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.head_sha) ||
    typeof value.pr_number !== "number" ||
    !Number.isSafeInteger(value.pr_number) ||
    value.pr_number < 0 ||
    typeof value.ci_run_id !== "number" ||
    !Number.isSafeInteger(value.ci_run_id) ||
    value.ci_run_id < 1
  ) {
    throw new CliError("Invalid asynchronous CI follow-up request.", 65);
  }
  return value as FollowUpRequest;
}

export function matchesFollowUpEvidence(
  combined: unknown,
  controlRepository: string,
  runId: number
): boolean {
  const status = latestCiStatus(combined, "CI Evidence");
  return (
    getJsonString(status, "state") === "success" &&
    trustedControlRunId(getJsonString(status, "target_url"), controlRepository) === runId
  );
}

export function isCurrentFollowUpTarget(request: FollowUpRequest, target: unknown): boolean {
  if (!isJsonRecord(target)) return false;
  if (request.pr_number === 0) {
    return getJsonString(target, "sha") === request.head_sha;
  }
  return (
    getJsonString(target, "state") === "open" &&
    isJsonRecord(target.head) &&
    getJsonString(target.head, "sha") === request.head_sha
  );
}

async function skipStaleFollowUp(request: FollowUpRequest): Promise<void> {
  console.log(
    `::notice::Skipping superseded CI follow-up for ${request.repository}@${request.head_sha}; no security scan or deployment will be dispatched.`
  );
  await appendLines(process.env.GITHUB_OUTPUT, ["current=false"]);
}

async function main(): Promise<void> {
  const rawRequest = process.env.CI_FOLLOW_UP_REQUEST_JSON ?? "";
  const rawPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";

  if (
    !controlToken ||
    !rawPolicy ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)
  ) {
    throw new CliError("CI follow-up control credentials are unavailable.", 77);
  }
  const request = parseFollowUpRequest(parseJson(rawRequest, "Invalid CI follow-up payload.", 65));
  validateRepositoryCapability(
    request.repository,
    parseJson(rawPolicy, "Invalid repository policy.", 65),
    "pr"
  );

  const reader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken
  );
  const status = await reader.get(`repos/${request.repository}/commits/${request.head_sha}/status`);
  if (!matchesFollowUpEvidence(status, controlRepository, request.ci_run_id)) {
    throw new CliError("CI follow-up does not own the successful CI Evidence status.", 65);
  }
  if (
    !(await hasVerifiedCiEvidence(reader, status, {
      controlRepository,
      workflowPaths: [".github/workflows/central-ci-dispatch.yml"],
      runAttempts: 18,
      retryDelayMs: 5_000,
    }))
  ) {
    throw new CliError("CI follow-up requires a completed, successful and trusted CI run.", 65);
  }
  if (request.pr_number > 0) {
    const pull = await reader.get(`repos/${request.repository}/pulls/${request.pr_number}`);
    if (!isJsonRecord(pull) || !isJsonRecord(pull.head)) {
      throw new CliError("CI follow-up received invalid PR revision facts.", 65);
    }
    if (!isCurrentFollowUpTarget(request, pull)) {
      await skipStaleFollowUp(request);
      return;
    }
  } else {
    const source = await reader.get(`repos/${request.repository}`);
    const branch = getJsonString(source, "default_branch");
    if (!branch) {
      throw new CliError("CI follow-up cannot determine the source default branch.", 65);
    }
    const currentCommit = await reader.get(
      `repos/${request.repository}/commits/${encodeURIComponent(branch)}`
    );
    if (!isJsonRecord(currentCommit) || !/^[0-9a-f]{40}$/.test(getJsonString(currentCommit, "sha"))) {
      throw new CliError("CI follow-up received an invalid default-branch head SHA.", 65);
    }
    if (!isCurrentFollowUpTarget(request, currentCommit)) {
      await skipStaleFollowUp(request);
      return;
    }
  }
  await appendLines(process.env.GITHUB_OUTPUT, ["current=true"]);
  console.log(
    `Verified CI follow-up: ${request.repository}@${request.head_sha} run=${request.ci_run_id}`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
