import { hasVerifiedCiEvidence, type JsonReader, latestCiStatus } from "./ci-evidence.ts";
import {
  decideCiFailureRetry,
  hasActiveCiEvidenceReservation,
  hasStaleCiEvidenceFailure,
  hasUnresolvedCiEvidenceFailure,
} from "./ci-failure-budget.ts";
import { requireStatusToken } from "./control-token.ts";
import { getJsonString, statusAwareReader } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { hasValidStatusAttestation } from "./status-attestation.ts";

/** Keep main-ref CI idempotent using the same attested lease and bounded retry
 * rules as PR dispatch. Skipping never writes a successful gate verdict. */
export async function shouldRunMainRefCi(
  response: unknown,
  reader: JsonReader,
  controlRepository: string,
  targetRepository: string,
  targetSha: string,
  controlHeadSha: string,
  nowMs = Date.now()
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

  if (
    await hasActiveCiEvidenceReservation(
      response,
      reader,
      controlRepository,
      targetRepository,
      targetSha,
      nowMs
    )
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
  const response = await reader.get(`repos/${repository}/commits/${sha}/status`);
  const shouldRun = await shouldRunMainRefCi(
    response,
    reader,
    controlRepository,
    repository,
    sha,
    process.env.GITHUB_SHA ?? ""
  );
  console.log(shouldRun ? "true" : "false");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
