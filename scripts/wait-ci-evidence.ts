import {
  getGithubJson,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { writeFile } from "node:fs/promises";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function policyNumber(value: Record<string, unknown>, key: string, fallback: number): number {
  return typeof value[key] === "number" ? value[key] : fallback;
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
    "### CI Evidence", "",
    `- workflow: ${evidence.workflow}`,
    `- run/status id: ${evidence.run_id}`,
    `- conclusion: ${evidence.conclusion}`,
    `- gate: ${evidence.gate_job}`,
    `- gate conclusion: ${evidence.gate_conclusion}`,
    "", "Jobs:",
    ...evidence.jobs.map((job) => `- ${job.name}: ${job.conclusion}`),
  ]);
  console.log(output);
}

async function waitForCentralStatus(
  repository: string,
  headSha: string,
  ci: Record<string, unknown>,
  token: string,
  pollSeconds: number,
  timeoutMinutes: number,
): Promise<void> {
  const context = getJsonString(ci, "status_context") || "CI Evidence";
  const deadline = Date.now() + timeoutMinutes * 60_000;

  while (Date.now() < deadline) {
    const response = await getGithubJson(`repos/${repository}/commits/${headSha}/status`, token);
    const statuses = getJsonArray(response, "statuses").filter(isJsonRecord);
    const status = statuses.find((item) => getJsonString(item, "context") === context);

    if (!status) {
      console.error(`Central CI pending: waiting for ${repository}@${headSha} context=${context}`);
      await sleep(pollSeconds * 1000);
      continue;
    }

    const state = getJsonString(status, "state") || "unknown";
    if (state === "pending") {
      console.error(`Central CI pending: ${repository}@${headSha} context=${context}`);
      await sleep(pollSeconds * 1000);
      continue;
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
    `::error::Timed out waiting for central CI: repository=${repository} head=${headSha} timeout=${timeoutMinutes}m`,
  );
}

async function waitForRepositoryWorkflow(
  repository: string,
  headSha: string,
  ci: Record<string, unknown>,
  token: string,
  pollSeconds: number,
  timeoutMinutes: number,
): Promise<void> {
  const workflow = getJsonString(ci, "workflow");
  const gateJobs = Array.isArray(ci.gate_jobs) ? ci.gate_jobs : [];
  if (!workflow) {
    throw new CliError("::error::CI evidence policy is missing workflow.", 65);
  }
  if (
    gateJobs.length === 0
    || !gateJobs.every((item) => typeof item === "string" && item)
    || new Set(gateJobs).size !== gateJobs.length
  ) {
    throw new CliError("::error::CI evidence policy gate_jobs is invalid.", 65);
  }

  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    const response = await getGithubJson(
      `repos/${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${headSha}&per_page=20`,
      token,
    );
    const runs = getJsonArray(response, "workflow_runs")
      .filter((item) => isJsonRecord(item) && getJsonString(item, "head_sha") === headSha)
      .sort((left, right) =>
        isJsonRecord(right) && isJsonRecord(left)
          ? getJsonString(right, "created_at").localeCompare(getJsonString(left, "created_at"))
          : 0
      );
    const runId = isJsonRecord(runs[0]) ? getJsonNumber(runs[0], "id") : 0;
    if (!runId) {
      console.error(`CI evidence pending: waiting for ${repository}@${headSha}`);
      await sleep(pollSeconds * 1000);
      continue;
    }

    const run = await getGithubJson(`repos/${repository}/actions/runs/${runId}`, token);
    const jobsResponse = await getGithubJson(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, token);
    const jobs = getJsonArray(jobsResponse, "jobs").filter(isJsonRecord);
    let selected: { gate: string; job: Record<string, unknown> } | undefined;
    for (const gate of gateJobs as string[]) {
      const job = jobs.find((item) => {
        const name = getJsonString(item, "name");
        return name === gate || name.endsWith(` / ${gate}`);
      });
      if (job) {
        selected = { gate, job };
        break;
      }
    }

    const runStatus = isJsonRecord(run) ? getJsonString(run, "status") || "unknown" : "unknown";
    if (!selected) {
      if (runStatus === "completed") {
        throw new CliError("::error::CI workflow completed without a supported evidence job.", 65);
      }
      console.error(`CI evidence pending: run=${runId} no supported evidence job yet`);
      await sleep(pollSeconds * 1000);
      continue;
    }

    const gateStatus = getJsonString(selected.job, "status") || "unknown";
    if (gateStatus !== "completed") {
      console.error(`CI evidence pending: run=${runId} gate=${selected.gate} status=${gateStatus}`);
      await sleep(pollSeconds * 1000);
      continue;
    }

    const jobResults = jobs.map((job) => ({
      name: getJsonString(job, "name").slice(0, 160),
      status: getJsonString(job, "status") || "unknown",
      conclusion: getJsonString(job, "conclusion") || "unknown",
    }));

    await publishEvidence({
      repository,
      head_sha: headSha,
      workflow,
      gate_job: selected.gate,
      run_id: runId,
      status: runStatus,
      conclusion: isJsonRecord(run) ? getJsonString(run, "conclusion") || "unknown" : "unknown",
      gate_conclusion: getJsonString(selected.job, "conclusion") || "unknown",
      jobs: jobResults,
    });
    return;
  }

  throw new CliError(
    `::error::Timed out waiting for repository CI: repository=${repository} head=${headSha} timeout=${timeoutMinutes}m`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new CliError("Usage: wait-ci-evidence.ts <repository> <head-sha> <policy-file>", 64);
  }

  const [repository = "", headSha = "", policyPath = ""] = args;
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

  const centralRepositories = Array.isArray(ci.central_repositories)
    ? ci.central_repositories.filter((item): item is string => typeof item === "string")
    : [];
  const token = process.env.GH_TOKEN ?? "";

  if (centralRepositories.includes(repository)) {
    await waitForCentralStatus(repository, headSha, ci, token, pollSeconds, timeoutMinutes);
    return;
  }

  await waitForRepositoryWorkflow(repository, headSha, ci, token, pollSeconds, timeoutMinutes);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
