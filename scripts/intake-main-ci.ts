import { trustedControlRunId } from "./ci-evidence.ts";
import { decideCiFailureRetry, hasUnresolvedCiEvidenceFailure } from "./ci-failure-budget.ts";
import { parseCiFailureMarker } from "./ci-failure-fingerprint.ts";
import { GithubHttpError, getJsonString, githubEnvironment, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { trustedIntakeTarget } from "./intake-event-scope.ts";
import { requireIntakeStatusToken, reserveIntakeCommitStatus } from "./intake-status-token.ts";
import { readRepositoryPolicyText, repositoriesForCapability } from "./repository-policy.ts";
import { CliError, handleError, isMain, parseJson, runCommand } from "./runtime-command.ts";
import { hasValidStatusAttestation, originalStatusDescription } from "./status-attestation.ts";

type GithubGet = {
  get(path: string): Promise<unknown>;
};

type Dispatch = (repository: string, headSha: string) => Promise<void>;
type Reserve = (repository: string, headSha: string) => Promise<void>;

export type CiIntakeResult = {
  repositories: number;
  dispatched: number;
  in_flight: number;
  already_processed: number;
  failed_repositories: string[];
};

const shaPattern = /^[0-9a-f]{40}$/;
export const PENDING_STATUS_LEASE_MS = 120_000;

type StatusFact = {
  state: string;
  target_url: string;
  updated_at: string;
  description: string;
};

function latestStatus(
  value: unknown,
  context: string,
  repository: string,
  sha: string
): StatusFact | null {
  if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
    throw new CliError("GitHub commit status response is invalid.", 65);
  }
  const latest = value.statuses
    .filter((item) => isJsonRecord(item) && getJsonString(item, "context") === context)
    .sort((left, right) =>
      getJsonString(right, "created_at").localeCompare(getJsonString(left, "created_at"))
    )[0];
  if (!isJsonRecord(latest) || !hasValidStatusAttestation(latest, { repository, sha, context })) {
    return null;
  }
  return {
    state: getJsonString(latest, "state"),
    target_url: getJsonString(latest, "target_url"),
    updated_at: getJsonString(latest, "updated_at"),
    description: originalStatusDescription(latest),
  };
}

function pendingLeaseActive(fact: StatusFact, nowMs = Date.now()): boolean {
  const updatedAtMs = Date.parse(fact.updated_at);
  return (
    Number.isFinite(updatedAtMs) &&
    nowMs >= updatedAtMs &&
    nowMs - updatedAtMs < PENDING_STATUS_LEASE_MS
  );
}

async function ciState(
  value: unknown,
  reader: GithubGet,
  controlRepository: string,
  repository: string,
  sha: string,
  currentControlHeadSha = ""
): Promise<"dispatch" | "in-flight" | "processed"> {
  const fact = latestStatus(value, "CI Evidence", repository, sha);
  if (!fact) return "dispatch";
  if (fact.state === "success") return "processed";
  // Failures with a stable, signed fingerprint can be retried only when log evidence classified
  // them as transient, the server delay elapsed, and fewer than three central runs failed.
  if (fact.state === "failure" || fact.state === "error") {
    const marker = parseCiFailureMarker(fact.description);
    if (fact.state === "failure" && marker) {
      if (!controlRepository) return "processed";
      const decision = await decideCiFailureRetry(
        value,
        reader,
        controlRepository,
        repository,
        sha
      );
      return decision === "retry" ? "dispatch" : decision === "wait" ? "in-flight" : "processed";
    }

    // Compatibility for pre-fingerprint statuses: only a new, verified control revision may
    // trigger one re-evaluation. Never repeat a legacy failure on the same control revision.
    if (!shaPattern.test(currentControlHeadSha) || !controlRepository) return "processed";
    const runId = trustedControlRunId(fact.target_url, controlRepository);
    if (!runId) return "processed";
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    if (
      !isJsonRecord(run) ||
      run.status !== "completed" ||
      run.event !== "repository_dispatch" ||
      run.conclusion !== "failure" ||
      typeof run.head_sha !== "string" ||
      !shaPattern.test(run.head_sha)
    ) {
      return "processed";
    }
    return run.head_sha === currentControlHeadSha ? "processed" : "dispatch";
  }
  if (fact.state !== "pending") return "processed";

  if (!controlRepository) {
    return "in-flight";
  }

  const runId = trustedControlRunId(fact.target_url, controlRepository);
  if (runId) {
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    const runStatus = isJsonRecord(run) && typeof run.status === "string" ? run.status : "";
    if (["queued", "in_progress", "pending", "waiting", "requested"].includes(runStatus)) {
      return "in-flight";
    }
    if (
      await hasUnresolvedCiEvidenceFailure(
        value,
        reader,
        controlRepository,
        repository,
        sha,
        currentControlHeadSha
      )
    ) {
      return "processed";
    }
  }

  return pendingLeaseActive(fact) ? "in-flight" : "dispatch";
}

async function defaultHead(reader: GithubGet, repository: string): Promise<string> {
  // GitHub defaults the List commits endpoint to the repository's default branch.
  // Request only its first commit so the default HEAD is resolved in one read.
  const commits = await reader.get(`repos/${repository}/commits?per_page=1`);
  if (!Array.isArray(commits) || !isJsonRecord(commits[0])) {
    throw new CliError(`GitHub default-branch commit list response is invalid: ${repository}.`, 65);
  }
  const sha = getJsonString(commits[0], "sha");
  if (!shaPattern.test(sha)) {
    throw new CliError(`Repository default head SHA is invalid: ${repository}.`, 65);
  }
  return sha;
}

export async function scanMainCi(
  policyValue: unknown,
  reader: GithubGet,
  dispatch: Dispatch,
  excludedRepository = "",
  reserve?: Reserve,
  onlyRepository = "",
  currentControlHeadSha = ""
): Promise<CiIntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "pr").filter(
    (repository) =>
      repository !== excludedRepository && (!onlyRepository || repository === onlyRepository)
  );
  const result: CiIntakeResult = {
    repositories: repositories.length,
    dispatched: 0,
    in_flight: 0,
    already_processed: 0,
    failed_repositories: [],
  };

  for (const repository of repositories) {
    try {
      const headSha = await defaultHead(reader, repository);
      const status = await reader.get(`repos/${repository}/commits/${headSha}/status`);
      const state = await ciState(
        status,
        reader,
        excludedRepository,
        repository,
        headSha,
        currentControlHeadSha
      );
      if (state === "in-flight") {
        result.in_flight += 1;
        continue;
      }
      if (state === "processed") {
        result.already_processed += 1;
        continue;
      }
      if (reserve) {
        await reserve(repository, headSha);
      }
      await dispatch(repository, headSha);
      result.dispatched += 1;
    } catch (error) {
      result.failed_repositories.push(repository);
      const detail =
        error instanceof GithubHttpError
          ? `GitHub HTTP ${error.status} (${error.kind})`
          : error instanceof CliError
            ? `CLI exit ${error.exitCode}`
            : error instanceof Error
              ? error.name
              : "unknown error";
      console.error(`::error::Main CI reconciliation failed for ${repository}: ${detail}.`);
    }
  }

  return result;
}

async function reserveCiStatus(
  controlRepository: string,
  token: string,
  repository: string,
  headSha: string
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const serverUrl = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  if (!runId) {
    throw new CliError("GITHUB_RUN_ID is required to reserve central CI status.", 64);
  }
  const targetUrl = `${serverUrl}/${controlRepository}/actions/runs/${runId}`;
  await reserveIntakeCommitStatus(
    token,
    repository,
    headSha,
    "CI Evidence",
    "Central CI queued by central intake",
    targetUrl
  );
}

async function dispatchCentralCi(
  controlRepository: string,
  token: string,
  repository: string,
  headSha: string
): Promise<void> {
  const safeRepository = repository.replace(/[^A-Za-z0-9_.-]/g, "-");
  const body = {
    event_type: "run-central-ci-ref",
    client_payload: {
      schema_version: "1",
      request_id: `ci-intake:${safeRepository}:${headSha.slice(0, 12)}`,
      repository,
      head_sha: headSha,
    },
  };

  await runCommand(
    "gh",
    ["api", "--method", "POST", `repos/${controlRepository}/dispatches`, "--input", "-"],
    {
      env: githubEnvironment(token),
      input: JSON.stringify(body),
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    }
  );
}

async function main(): Promise<void> {
  const policyRaw = readRepositoryPolicyText() ?? "";
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const statusToken = requireIntakeStatusToken(process.env.AW_STATUS_API_TOKEN);
  const ingressToken = process.env.AW_DISPATCH_API_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  // A task source request needs CI for its own repository now, not on the next scheduled scan.
  const onlyRepository = process.env.AW_CI_INTAKE_REPOSITORY ?? "";

  if (onlyRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(onlyRepository)) {
    throw new CliError("AW_CI_INTAKE_REPOSITORY must be owner/repository.", 64);
  }

  if (!policyRaw || !controlToken || !ingressToken || !controlRepository) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN, AW_DISPATCH_API_TOKEN, and AW_CONTROL_REPOSITORY are required.",
      64
    );
  }

  const policy = parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65);
  const target = trustedIntakeTarget(policy, process.env.AW_INTAKE_TARGET_REPOSITORY ?? "");
  const reader = statusAwareReader(apiUrl, controlToken, statusToken);
  const result = await scanMainCi(
    policy,
    reader,
    async (repository, headSha) => {
      await dispatchCentralCi(controlRepository, ingressToken, repository, headSha);
    },
    controlRepository,
    async (repository, headSha) => {
      await reserveCiStatus(controlRepository, statusToken, repository, headSha);
    },
    onlyRepository || target,
    process.env.GITHUB_SHA ?? ""
  );

  console.log(JSON.stringify(result));
  if (result.failed_repositories.length > 0) {
    throw new CliError(
      `Main CI intake partially failed for ${result.failed_repositories.length} repositories: ${result.failed_repositories.join(", ")}.`,
      1
    );
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
