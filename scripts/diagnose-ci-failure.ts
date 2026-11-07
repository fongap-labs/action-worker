import { appendFileSync } from "node:fs";
import { CliError, handleError, isMain } from "./runtime-command.ts";

export type FailureKind = "security" | "authorization" | "code" | "infrastructure" | "unknown";
export type FailedStep = {
  job: string;
  step: string;
  kind: FailureKind;
  severity: "high" | "medium" | "low";
  recommendation: string;
};

export type WorkflowJobFact = {
  name?: string;
  conclusion?: string | null;
  steps?: Array<{ name?: string; conclusion?: string | null }>;
};

export function classifyFailure(job: string, step: string): FailedStep {
  const label = `${job} ${step}`.toLowerCase();
  if (/secret|security (?:scan|checks|gate)|attestation|provenance|main write guard|signature/.test(label)) {
    return {
      job,
      step,
      kind: "security",
      severity: "high",
      recommendation: "Inspect the security evidence and trusted source; never bypass the gate.",
    };
  }
  if (/permission|app token|mint .*token|unauthorized|access denied|credential/.test(label)) {
    return {
      job,
      step,
      kind: "authorization",
      severity: "high",
      recommendation: "Check GitHub App installation scope and the requested token permissions.",
    };
  }
  if (/lint|biome|typescript|type.check|unit tests|contract tests|naming|actionlint|static analysis/.test(label)) {
    return {
      job,
      step,
      kind: "code",
      severity: "medium",
      recommendation: "Fix the code or test failure; rerun the unchanged merge gate.",
    };
  }
  if (/checkout|setup node|install dependencies|npm ci|runner|network|rate limit|download/.test(label)) {
    return {
      job,
      step,
      kind: "infrastructure",
      severity: "low",
      recommendation: "Check the runner and dependency availability; retry only transient failures.",
    };
  }
  return {
    job,
    step,
    kind: "unknown",
    severity: "medium",
    recommendation: "Read the failed job log and classify the root cause before making changes.",
  };
}

export function summarizeFailures(jobs: readonly WorkflowJobFact[]): FailedStep[] {
  const failures: FailedStep[] = [];
  for (const job of jobs) {
    // The aggregator is only the messenger. Report the upstream failure instead.
    if (!job.name || job.name === "validate-merge" || job.conclusion !== "failure") continue;
    const steps = (job.steps ?? []).filter((step) => step.conclusion === "failure");
    if (steps.length === 0) {
      failures.push(classifyFailure(job.name, "Unknown failing step"));
      continue;
    }
    for (const step of steps) {
      failures.push(classifyFailure(job.name, step.name || "Unknown failing step"));
    }
  }
  const weight = { high: 0, medium: 1, low: 2 };
  return failures.sort((a, b) => weight[a.severity] - weight[b.severity]);
}

function safeLabel(value: string): string {
  return value.replace(/[\r\n|]/g, " ").slice(0, 140);
}

export function markdownFailureSummary(
  findings: readonly FailedStep[],
  repository: string,
  runId: string
): string {
  const url = `https://github.com/${repository}/actions/runs/${runId}`;
  const rows = findings.slice(0, 20).map((item) => {
    return `| ${safeLabel(item.job)} | ${safeLabel(item.step)} | ${item.kind} / ${item.severity} | ${safeLabel(item.recommendation)} |`;
  });
  return [
    "### CI failure triage (informational; cannot override the merge gate)",
    "",
    `[Open the failed run](${url})`,
    "",
    "| Job | Failed step | Category / severity | Suggested verification |",
    "| --- | --- | --- | --- |",
    ...rows,
    ...(findings.length > 20 ? ["", `Further failed steps omitted: ${findings.length - 20}.`] : []),
    ...(!findings.length ? ["", "No failed upstream step was visible; inspect the run directly."] : []),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const summaryPath = process.env.GITHUB_STEP_SUMMARY ?? "";
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(runId) || !summaryPath) {
    throw new CliError("GitHub Actions read token and run metadata are required.", 65);
  }

  const jobs: WorkflowJobFact[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) throw new CliError(`Cannot read CI jobs (HTTP ${response.status}).`, 65);
    const payload = (await response.json()) as { jobs?: WorkflowJobFact[] };
    if (!Array.isArray(payload.jobs)) throw new CliError("Invalid GitHub job response.", 65);
    jobs.push(...payload.jobs);
    if (payload.jobs.length < 100) break;
    if (page === 10) throw new CliError("Job list exceeded pagination limit.", 65);
  }

  const findings = summarizeFailures(jobs);
  appendFileSync(summaryPath, markdownFailureSummary(findings, repository, runId), "utf8");
  // Do not create an Issue, a duplicate notification or a privileged retry here.
  console.log(`CI triage completed: ${findings.length} failed step(s); merge gate remains unchanged.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
