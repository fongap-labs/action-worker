import { writeFile } from "node:fs/promises";
import { hasVerifiedCiEvidence, type JsonReader, trustedCiStatus } from "./ci-evidence.ts";
import { getJsonNumber, getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, readJson } from "./runtime-command.ts";
import { requireStatusToken } from "./status-attestation.ts";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function policyNumber(value: Record<string, unknown>, key: string, fallback: number): number {
  return typeof value[key] === "number" ? value[key] : fallback;
}

export function calculateBackoff(
  attempt: number,
  initialMs: number,
  maxMs: number,
  remainingMs: number,
  jitterFactor = 0.2
): number {
  // Bound every request by the configured deadline. The capped interval also
  // limits API usage without introducing a second, shorter attempt deadline.
  const capped = Math.min(initialMs * 2 ** Math.min(attempt, 30), maxMs);
  const jitter = capped * jitterFactor * Math.random();
  return Math.max(0, Math.min(remainingMs, Math.floor(capped + jitter)));
}

export async function assertCurrentPullHead(
  reader: JsonReader,
  repository: string,
  prNumber: number,
  headSha: string
): Promise<void> {
  const pull = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  if (!isJsonRecord(pull) || !isJsonRecord(pull.head)) {
    throw new CliError("::error::Cannot verify the current pull request revision.", 65);
  }
  const currentHead = getJsonString(pull.head, "sha");
  if (getJsonString(pull, "state") !== "open" || currentHead !== headSha) {
    throw new CliError(
      `::error::Abandoning obsolete CI wait for ${repository}#${prNumber}: ` +
        `expected head ${headSha}, current head ${currentHead || "<missing>"}.`,
      75
    );
  }
}

type Evidence = {
  repository: string;
  head_sha: string;
  workflow: string;
  gate_job: string;
  run_id: number;
  status: string;
  conclusion: string;
  gate_conclusion: string;
  jobs: Array<{ name: string; status: string; conclusion: string }>;
};

async function publishEvidence(evidence: Evidence): Promise<void> {
  const output = JSON.stringify(evidence);
  if (process.env.CI_EVIDENCE_PATH) {
    await writeFile(process.env.CI_EVIDENCE_PATH, `${output}\n`, "utf8");
  }
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "### CI Evidence",
    "",
    `- workflow: ${evidence.workflow}`,
    `- run/status id: ${evidence.run_id}`,
    `- conclusion: ${evidence.conclusion}`,
    `- gate: ${evidence.gate_job}`,
    `- gate conclusion: ${evidence.gate_conclusion}`,
    "",
    "Jobs:",
    ...evidence.jobs.map((job) => `- ${job.name}: ${job.conclusion}`),
  ]);
  console.log(output);
}

export async function waitForCentralStatus(
  repository: string,
  headSha: string,
  ci: Record<string, unknown>,
  reader: JsonReader,
  controlRepository: string,
  pollSeconds: number,
  timeoutMinutes: number,
  prNumber?: number
): Promise<void> {
  const context = getJsonString(ci, "status_context") || "CI Evidence";
  const deadline = Date.now() + timeoutMinutes * 60_000;

  // Back off to at most one request per minute while honoring the full
  // policy deadline (30 attempts previously ended a 120-minute wait early).
  const initialPollMs = pollSeconds * 1000;
  const maxPollMs = 60_000;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (prNumber !== undefined) {
      await assertCurrentPullHead(reader, repository, prNumber, headSha);
    }
    const response = await reader.get(`repos/${repository}/commits/${headSha}/status`);
    const status = trustedCiStatus(response, context, controlRepository);
    attempt++;

    if (!status) {
      console.error(
        `Central CI pending: waiting for trusted ${repository}@${headSha} context=${context} (poll ${attempt}, remaining ${Math.ceil(Math.max(0, deadline - Date.now()) / 60_000)}m)`
      );
      if (Date.now() < deadline) {
        await sleep(calculateBackoff(attempt, initialPollMs, maxPollMs, deadline - Date.now()));
      }
      continue;
    }

    const state = getJsonString(status, "state") || "unknown";
    if (state === "pending") {
      console.error(
        `Central CI pending: ${repository}@${headSha} context=${context} (poll ${attempt}, remaining ${Math.ceil(Math.max(0, deadline - Date.now()) / 60_000)}m)`
      );
      if (Date.now() < deadline) {
        await sleep(calculateBackoff(attempt, initialPollMs, maxPollMs, deadline - Date.now()));
      }
      continue;
    }

    // A run URL in the status is only a claim. A success counts once the control run it names
    // is confirmed as a successful CI Evidence run; wait for that run within the CI deadline.
    if (state === "success") {
      const pollMs = pollSeconds * 1000;
      const verified = await hasVerifiedCiEvidence(reader, response, {
        controlRepository,
        targetRepository: repository,
        targetSha: headSha,
        runAttempts: Math.max(1, Math.ceil((deadline - Date.now()) / pollMs)),
        retryDelayMs: pollMs,
      });
      if (!verified) {
        throw new CliError(
          `::error::CI Evidence for ${repository}@${headSha} was not produced by a successful Action Worker CI run.`,
          65
        );
      }
    }

    if (prNumber !== undefined) {
      await assertCurrentPullHead(reader, repository, prNumber, headSha);
    }
    const conclusion = state === "success" ? "success" : "failure";
    await publishEvidence({
      repository,
      head_sha: headSha,
      workflow: "central-ci",
      gate_job: context,
      run_id: getJsonNumber(status, "id"),
      status: "completed",
      conclusion,
      gate_conclusion: conclusion,
      jobs: [{ name: context, status: "completed", conclusion }],
    });
    return;
  }

  throw new CliError(
    `::error::Timed out waiting for central CI: repository=${repository} head=${headSha} timeout=${timeoutMinutes}m attempts=${attempt}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError(
      "Usage: wait-ci-evidence.ts <repository> <head-sha> <policy-file> <pr-number>",
      64
    );
  }

  const [repository = "", headSha = "", policyPath = "", prNumber = ""] = args;
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new CliError("::error::Invalid CI pull request number.", 65);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError("::error::Invalid CI repository.", 65);
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new CliError("::error::Invalid CI head SHA.", 65);
  }

  const policy = await readJson(policyPath);
  const ci = isJsonRecord(policy) && isJsonRecord(policy.ci) ? policy.ci : {};
  const pollSeconds = policyNumber(ci, "poll_seconds", 15);
  const timeoutMinutes = policyNumber(ci, "timeout_minutes", 20);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 120) {
    throw new CliError("::error::CI poll_seconds must be 5-120 seconds.", 65);
  }
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
    throw new CliError("::error::CI timeout_minutes must be 1-120 minutes.", 65);
  }

  const statusToken = requireStatusToken();
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!controlToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) {
    throw new CliError("::error::Central CI evidence authority is unavailable.", 65);
  }
  await waitForCentralStatus(
    repository,
    headSha,
    ci,
    statusAwareReader(
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      controlToken,
      statusToken
    ),
    controlRepository,
    pollSeconds,
    timeoutMinutes,
    Number(prNumber)
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
