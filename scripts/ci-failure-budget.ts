import {
  hasVerifiedCiFailureStatus,
  type JsonReader,
  latestCiStatus,
  trustedControlRunId,
} from "./ci-evidence.ts";
import {
  ciFailureRetryDelayMs,
  maxCiFailureAttempts,
  parseCiFailureMarker,
} from "./ci-failure-fingerprint.ts";
import { getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import {
  hasValidStatusAttestation,
  originalStatusDescription,
  statusRunAttempt,
} from "./status-attestation.ts";

const pendingLeaseMs = 120_000;
const activeRunStates = ["queued", "in_progress", "pending", "waiting", "requested"];

export type CiFailureRetryDecision = "retry" | "wait" | "stop";

/** A source SHA gets at most three signed, log-backed retries for the same failure fingerprint. */
export async function decideCiFailureRetry(
  response: unknown,
  reader: JsonReader,
  controlRepository: string,
  targetRepository: string,
  targetSha: string,
  nowMs = Date.now()
): Promise<CiFailureRetryDecision> {
  const latest = latestCiStatus(response, "CI Evidence");
  if (
    !latest ||
    getJsonString(latest, "state") !== "failure" ||
    !hasValidStatusAttestation(latest, {
      repository: targetRepository,
      sha: targetSha,
      context: "CI Evidence",
    })
  ) {
    return "stop";
  }
  const marker = parseCiFailureMarker(originalStatusDescription(latest));
  if (!marker?.retryable) return "stop";

  const statuses = getJsonArray(response, "statuses")
    .filter(isJsonRecord)
    .filter(
      (status) =>
        getJsonString(status, "context") === "CI Evidence" &&
        getJsonString(status, "state") === "failure" &&
        hasValidStatusAttestation(status, {
          repository: targetRepository,
          sha: targetSha,
          context: "CI Evidence",
        })
    )
    .sort((left, right) =>
      getJsonString(right, "created_at").localeCompare(getJsonString(left, "created_at"))
    );

  const seen = new Set<string>();
  let failureCount = 0;
  for (const status of statuses) {
    const historical = parseCiFailureMarker(originalStatusDescription(status));
    if (!historical?.retryable || historical.fingerprint !== marker.fingerprint) continue;
    const runId = trustedControlRunId(getJsonString(status, "target_url"), controlRepository);
    const attempt = statusRunAttempt(status);
    if (!runId || attempt === null) return "stop";
    const runKey = `${runId}:${attempt}`;
    if (seen.has(runKey)) continue;
    seen.add(runKey);

    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    if (isJsonRecord(run) && activeRunStates.includes(getJsonString(run, "status"))) return "wait";
    if (
      !(await hasVerifiedCiFailureStatus(reader, status, {
        controlRepository,
        targetRepository,
        targetSha,
      }))
    ) {
      return "stop";
    }
    failureCount += 1;
    if (failureCount >= maxCiFailureAttempts) return "stop";
  }

  if (failureCount < 1) return "stop";
  const failedAt = Date.parse(getJsonString(latest, "created_at"));
  if (!Number.isFinite(failedAt)) return "stop";
  const delayMs = ciFailureRetryDelayMs(failureCount, marker.fingerprint, marker.retryAfterSeconds);
  return nowMs < failedAt + delayMs ? "wait" : "retry";
}

/** Prevents duplicate dispatch while a signed control run or its short lease is active. */
export async function hasActiveCiEvidenceReservation(
  response: unknown,
  reader: JsonReader,
  controlRepository: string,
  targetRepository: string,
  targetSha: string,
  nowMs = Date.now()
): Promise<boolean> {
  const latest = latestCiStatus(response, "CI Evidence");
  if (
    !latest ||
    getJsonString(latest, "state") !== "pending" ||
    !hasValidStatusAttestation(latest, {
      repository: targetRepository,
      sha: targetSha,
      context: "CI Evidence",
    })
  ) {
    return false;
  }

  const runId = trustedControlRunId(getJsonString(latest, "target_url"), controlRepository);
  if (runId) {
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    if (
      isJsonRecord(run) &&
      getJsonString(run.repository, "full_name") === controlRepository &&
      getJsonString(run, "head_branch") === "main" &&
      [
        ".github/workflows/central-ci-dispatch.yml",
        ".github/workflows/handle-pr-dispatch.yml",
      ].includes(getJsonString(run, "path")) &&
      activeRunStates.includes(getJsonString(run, "status"))
    ) {
      return true;
    }
  }

  const updatedAt = Date.parse(getJsonString(latest, "updated_at"));
  return Number.isFinite(updatedAt) && nowMs >= updatedAt && nowMs - updatedAt < pendingLeaseMs;
}

/** A failed publisher that left only pending status must not be dispatched every intake tick. */
export async function hasUnresolvedCiEvidenceFailure(
  response: unknown,
  reader: JsonReader,
  controlRepository: string,
  targetRepository: string,
  targetSha: string,
  currentControlHeadSha: string
): Promise<boolean> {
  const latest = latestCiStatus(response, "CI Evidence");
  if (
    !latest ||
    getJsonString(latest, "state") !== "pending" ||
    !hasValidStatusAttestation(latest, {
      repository: targetRepository,
      sha: targetSha,
      context: "CI Evidence",
    })
  ) {
    return false;
  }

  const runId = trustedControlRunId(getJsonString(latest, "target_url"), controlRepository);
  if (!runId) return false;
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
  if (!isJsonRecord(run)) return false;
  const workflowPath = getJsonString(run, "path");
  const event = getJsonString(run, "event");
  if (
    getJsonString(run.repository, "full_name") !== controlRepository ||
    getJsonString(run, "head_branch") !== "main" ||
    getJsonString(run, "status") !== "completed" ||
    getJsonString(run, "conclusion") !== "failure" ||
    (workflowPath !== ".github/workflows/intake.yml" && event !== "repository_dispatch") ||
    ![
      ".github/workflows/central-ci-dispatch.yml",
      ".github/workflows/handle-pr-dispatch.yml",
      ".github/workflows/intake.yml",
    ].includes(workflowPath) ||
    !/^[0-9a-f]{40}$/.test(getJsonString(run, "head_sha"))
  ) {
    return false;
  }

  if (workflowPath === ".github/workflows/intake.yml") {
    const jobsPath = `repos/${controlRepository}/actions/runs/${runId}/jobs?per_page=100`;
    const jobs = await reader.get(jobsPath);
    const mainCiJob = getJsonArray(jobs, "jobs")
      .filter(isJsonRecord)
      .find((job) => getJsonString(job, "name") === "Main CI");
    if (getJsonString(mainCiJob, "conclusion") !== "failure") return false;
  }

  // Without a valid current control SHA, do not assume that an implementation change fixed it.
  return (
    !/^[0-9a-f]{40}$/.test(currentControlHeadSha) ||
    getJsonString(run, "head_sha") === currentControlHeadSha
  );
}
