import { setTimeout as sleep } from "node:timers/promises";
import {
  hasVerifiedCiEvidence,
  type JsonReader,
  latestCiStatus,
  trustedControlRunId,
} from "./ci-evidence.ts";
import {
  decideCiFailureRetry,
  hasActiveCiEvidenceReservation,
  hasStaleCiEvidenceFailure,
  hasUnresolvedCiEvidenceFailure,
} from "./ci-failure-budget.ts";
import { requireStatusToken } from "./control-token.ts";
import { getJsonArray, getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { hasValidStatusAttestation, originalStatusDescription } from "./status-attestation.ts";

/**
 * A completed, successful control-plane intake has already reserved and dispatched
 * this main-ref CI. Its signed pending status is the handoff ticket, not a running
 * Central CI job. Validate the exact intake run and Main CI dispatch job before
 * admitting the receiver to consume the ticket; all other leases remain enforced.
 */
export async function isTrustedIntakeCiHandoff(
  response: unknown,
  reader: JsonReader,
  controlRepository: string,
  targetRepository: string,
  targetSha: string,
  controlHeadSha: string
): Promise<boolean> {
  const latest = latestCiStatus(response, "CI Evidence");
  if (
    !latest ||
    getJsonString(latest, "state") !== "pending" ||
    originalStatusDescription(latest) !== "Central CI queued by central intake" ||
    !/^[0-9a-f]{40}$/.test(controlHeadSha) ||
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
  if (
    !isJsonRecord(run) ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    getJsonString(run, "path") !== ".github/workflows/intake.yml" ||
    getJsonString(run, "head_branch") !== "main" ||
    getJsonString(run, "head_sha") !== controlHeadSha ||
    getJsonString(run, "status") !== "completed" ||
    getJsonString(run, "conclusion") !== "success"
  ) {
    return false;
  }
  const jobs = await reader.get(
    `repos/${controlRepository}/actions/runs/${runId}/jobs?per_page=100`
  );
  const mainCiJobs = getJsonArray(jobs, "jobs")
    .filter(isJsonRecord)
    .filter((job) => getJsonString(job, "name") === "Main CI");
  return mainCiJobs.length === 1 && getJsonString(mainCiJobs[0], "conclusion") === "success";
}

const pendingIntakeStates = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);

/**
 * The intake job dispatches CI before the enclosing workflow can finish.
 * Wait for that signed intake to settle before applying the original fail-closed
 * handoff verifier. Waiting does not grant CI permission or accept a failed run.
 */
export async function waitForSignedIntakeCompletion(
  response: unknown,
  reader: JsonReader,
  controlRepository: string,
  targetRepository: string,
  targetSha: string,
  controlHeadSha: string,
  delay: (ms: number) => Promise<void> = sleep,
  maxChecks = 18
): Promise<boolean> {
  const latest = latestCiStatus(response, "CI Evidence");
  if (
    !latest ||
    getJsonString(latest, "state") !== "pending" ||
    originalStatusDescription(latest) !== "Central CI queued by central intake" ||
    !/^[0-9a-f]{40}$/.test(controlHeadSha) ||
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

  for (let check = 0; check < maxChecks; check += 1) {
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    if (
      !isJsonRecord(run) ||
      getJsonString(run.repository, "full_name") !== controlRepository ||
      getJsonString(run, "path") !== ".github/workflows/intake.yml" ||
      getJsonString(run, "head_branch") !== "main" ||
      getJsonString(run, "head_sha") !== controlHeadSha
    ) {
      return false;
    }
    const status = getJsonString(run, "status");
    if (status === "completed") return true;
    if (!pendingIntakeStates.has(status) || check === maxChecks - 1) return false;
    await delay(5_000);
  }
  return false;
}

/** Keep main-ref CI idempotent using the same attested lease and bounded retry
 * rules as PR dispatch. Skipping never writes a successful gate verdict. */
export async function shouldRunMainRefCi(
  response: unknown,
  reader: JsonReader,
  controlRepository: string,
  targetRepository: string,
  targetSha: string,
  controlHeadSha: string,
  nowMs = Date.now(),
  isDispatchedMainRef = false
): Promise<boolean> {
  if (
    await hasVerifiedCiEvidence(reader, response, {
      controlRepository,
      targetRepository,
      targetSha,
      runAttempts: 1,
      retryDelayMs: 0,
    })
  ) {
    return false;
  }

  const intakeHandoff =
    isDispatchedMainRef &&
    (await isTrustedIntakeCiHandoff(
      response,
      reader,
      controlRepository,
      targetRepository,
      targetSha,
      controlHeadSha
    ));

  if (
    !intakeHandoff &&
    (await hasActiveCiEvidenceReservation(
      response,
      reader,
      controlRepository,
      targetRepository,
      targetSha,
      nowMs
    ))
  ) {
    return false;
  }

  if (
    await hasUnresolvedCiEvidenceFailure(
      response,
      reader,
      controlRepository,
      targetRepository,
      targetSha,
      controlHeadSha
    )
  ) {
    return false;
  }

  if (
    await hasStaleCiEvidenceFailure(
      response,
      reader,
      controlRepository,
      targetRepository,
      targetSha,
      controlHeadSha
    )
  ) {
    return true;
  }

  const latest = latestCiStatus(response, "CI Evidence");
  const state = getJsonString(latest, "state");
  if (
    (state === "failure" || state === "error") &&
    hasValidStatusAttestation(latest, {
      repository: targetRepository,
      sha: targetSha,
      context: "CI Evidence",
    })
  ) {
    return (
      state === "failure" &&
      (await decideCiFailureRetry(
        response,
        reader,
        controlRepository,
        targetRepository,
        targetSha,
        nowMs
      )) === "retry"
    );
  }

  // Untrusted or absent evidence never suppresses a real CI run.
  return true;
}

async function main(): Promise<void> {
  const [repository = "", sha = ""] = process.argv.slice(2);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new CliError("Usage: should-run-central-ci.ts <repository> <sha>", 64);
  }
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const statusToken = requireStatusToken();
  if (!controlToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) {
    throw new CliError("AW_CONTROL_TOKEN and GITHUB_REPOSITORY are required.", 77);
  }
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken,
    statusToken
  );
  const statusPath = `repos/${repository}/commits/${sha}/status`;
  let response = await reader.get(statusPath);
  if (
    await waitForSignedIntakeCompletion(
      response,
      reader,
      controlRepository,
      repository,
      sha,
      process.env.GITHUB_SHA ?? ""
    )
  ) {
    response = await reader.get(statusPath);
  }
  const shouldRun = await shouldRunMainRefCi(
    response,
    reader,
    controlRepository,
    repository,
    sha,
    process.env.GITHUB_SHA ?? "",
    Date.now(),
    true
  );
  console.log(shouldRun ? "true" : "false");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
