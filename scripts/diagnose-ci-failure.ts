import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, handleError, isMain, runCommand } from "./runtime-command.ts";

export type FailureKind =
  | "transient_network"
  | "api_rate_limit"
  | "upstream_service"
  | "runner"
  | "dependency"
  | "configuration"
  | "permission"
  | "credential_missing"
  | "source_test"
  | "security_gate"
  | "stale_task"
  | "unknown";

export type FailedStep = {
  job: string;
  step: string;
  kind: FailureKind;
  severity: "high" | "medium" | "low";
  recoverability: "safe_retry" | "do_not_retry" | "unknown";
  evidence: "job_log" | "step_name" | "unavailable";
  recommendation: string;
  job_url?: string;
};

export type WorkflowJobFact = {
  id?: number;
  name?: string;
  html_url?: string;
  conclusion?: string | null;
  steps?: Array<{ name?: string; conclusion?: string | null }>;
};

type FailureRule = {
  kind: FailureKind;
  severity: FailedStep["severity"];
  recoverability: FailedStep["recoverability"];
  recommendation: string;
  pattern: RegExp;
};

const failureRules: readonly FailureRule[] = [
  {
    kind: "credential_missing",
    severity: "high",
    recoverability: "do_not_retry",
    recommendation:
      "Verify the existing credential name and Environment scope without reading its value.",
    pattern:
      /missing required .{0,100}(?:token|secret|credential|api key|private key)|(?:secret|token|credential) (?:was )?(?:not found|not available|is unavailable)/i,
  },
  {
    kind: "permission",
    severity: "high",
    recoverability: "do_not_retry",
    recommendation:
      "Check the installed app scope and requested permission; keep the existing gate enabled.",
    pattern:
      /\bHTTP\s*(?:401|403)\b|permission denied|resource not accessible|insufficient scope|unauthorized|access denied/i,
  },
  {
    kind: "security_gate",
    severity: "high",
    recoverability: "do_not_retry",
    recommendation: "Review the security evidence and trusted source; never bypass the gate.",
    pattern:
      /secret scanning|security (?:scan|checks|gate)|attestation|provenance|signature verification|main write guard/i,
  },
  {
    kind: "api_rate_limit",
    severity: "low",
    recoverability: "safe_retry",
    recommendation: "Retry within the task budget after the server-provided rate-limit delay.",
    pattern: /\bHTTP\s*429\b|rate limit|secondary rate limit|abuse detection|retry-after/i,
  },
  {
    kind: "transient_network",
    severity: "low",
    recoverability: "safe_retry",
    recommendation:
      "Retry the idempotent operation with bounded backoff; stop when its budget is exhausted.",
    pattern:
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|fetch failed|socket hang up|connection reset|temporary failure in name resolution|network is unreachable/i,
  },
  {
    kind: "upstream_service",
    severity: "low",
    recoverability: "safe_retry",
    recommendation:
      "Retry once the upstream service recovers, respecting Retry-After and the task budget.",
    pattern:
      /\bHTTP\s*5(?:00|02|03|04)\b|internal server error|bad gateway|service unavailable|gateway timeout|upstream (?:service )?(?:error|unavailable)/i,
  },
  {
    kind: "runner",
    severity: "low",
    recoverability: "safe_retry",
    recommendation:
      "Confirm the runner was lost or unavailable, then retry the idempotent job once within budget.",
    pattern:
      /runner (?:was )?(?:lost|unavailable|shutdown)|failed to provision (?:a )?runner|runner has received a shutdown signal|no hosted parallelism/i,
  },
  {
    kind: "dependency",
    severity: "medium",
    recoverability: "do_not_retry",
    recommendation:
      "Inspect the dependency and lockfile error; retry only if the log proves a transient fetch failure.",
    pattern:
      /npm ERR!|ERESOLVE|unable to resolve dependency|lockfile (?:is )?(?:out of date|incompatible)|package .* not found|could not resolve dependency/i,
  },
  {
    kind: "configuration",
    severity: "medium",
    recoverability: "do_not_retry",
    recommendation:
      "Correct the named configuration at its owning scope; do not retry unchanged input.",
    pattern:
      /invalid (?:configuration|config|environment variable)|missing required configuration|must be configured|malformed (?:configuration|input)|\b(?:is|was) invalid\b|is unavailable or invalid/i,
  },
  {
    kind: "stale_task",
    severity: "medium",
    recoverability: "do_not_retry",
    recommendation:
      "Skip this stale task and evaluate the current source SHA before dispatching work.",
    pattern:
      /task (?:has )?(?:expired|is stale)|stale (?:task|head|sha)|superseded (?:head|commit|task)|no longer current|outdated head sha/i,
  },
  {
    kind: "source_test",
    severity: "medium",
    recoverability: "do_not_retry",
    recommendation: "Fix the source or test failure and rerun the unchanged merge gate.",
    pattern:
      /AssertionError|\bnot ok \d|test(?:s)? failed|typecheck failed|typescript error|lint failed|biome check failed|contract assertion/i,
  },
];

function finding(
  job: string,
  step: string,
  rule: FailureRule,
  evidence: FailedStep["evidence"]
): FailedStep {
  return {
    job,
    step,
    kind: rule.kind,
    severity: rule.severity,
    recoverability: evidence === "job_log" ? rule.recoverability : "unknown",
    evidence,
    recommendation:
      evidence === "job_log"
        ? rule.recommendation
        : "Step names are not root-cause evidence; inspect the failed job log before retrying.",
  };
}

function fallbackRule(label: string): FailureRule | undefined {
  let kind: FailureKind | undefined;
  if (/secret|security|attestation|provenance|signature/.test(label)) kind = "security_gate";
  else if (/permission|app token|mint .*token|unauthorized|access denied|credential/.test(label))
    kind = "permission";
  else if (/rate limit|quota/.test(label)) kind = "api_rate_limit";
  else if (/network|timeout|checkout|runner|download/.test(label)) kind = "transient_network";
  else if (/npm|install dependencies|dependency/.test(label)) kind = "dependency";
  else if (/config|environment|variable/.test(label)) kind = "configuration";
  else if (/expired|stale|superseded/.test(label)) kind = "stale_task";
  else if (
    /lint|biome|typescript|type.check|unit tests|contract tests|naming|actionlint|static analysis/.test(
      label
    )
  )
    kind = "source_test";
  return failureRules.find((rule) => rule.kind === kind);
}

/** Error text from a failed job takes precedence; step labels alone never authorize a retry. */
export function classifyFailure(job: string, step: string, errorText = ""): FailedStep {
  const detail = errorText.trim();
  if (detail) {
    for (const rule of failureRules) {
      if (rule.pattern.test(detail)) return finding(job, step, rule, "job_log");
    }
    return {
      job,
      step,
      kind: "unknown",
      severity: "medium",
      recoverability: "unknown",
      evidence: "job_log",
      recommendation:
        "The log did not match a known cause; inspect it before changing code or retrying.",
    };
  }

  const rule = fallbackRule(`${job} ${step}`.toLowerCase());
  if (rule) return finding(job, step, rule, "step_name");
  return {
    job,
    step,
    kind: "unknown",
    severity: "medium",
    recoverability: "unknown",
    evidence: "unavailable",
    recommendation: "Read the failed job log and classify the root cause before making changes.",
  };
}

function safeJobUrl(value: string | undefined): string | undefined {
  return typeof value === "string" &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+\/job\/[0-9]+$/.test(
      value
    )
    ? value
    : undefined;
}

function usefulFailureLines(log: string): string {
  const lines = log.split(/\r?\n/);
  const annotated = lines.filter((line) =>
    /##\[error\]|\b(?:Error|Exception|Failed|failure):|\bHTTP\s*(?:401|403|408|429|5\d\d)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|npm ERR!|AssertionError/i.test(
      line
    )
  );
  return (annotated.length ? annotated.slice(-80) : lines.slice(-80)).join("\n");
}

export function summarizeFailures(
  jobs: readonly WorkflowJobFact[],
  logsByJobId: ReadonlyMap<number, string> = new Map()
): FailedStep[] {
  const failures: FailedStep[] = [];
  for (const job of jobs) {
    // The aggregator is only the messenger. Report the upstream failure instead.
    if (!job.name || job.name === "validate-merge" || job.conclusion !== "failure") continue;
    const steps = (job.steps ?? []).filter((step) => step.conclusion === "failure");
    const errorText = job.id ? usefulFailureLines(logsByJobId.get(job.id) ?? "") : "";
    if (steps.length === 0) {
      failures.push({
        ...classifyFailure(job.name, "Unknown failing step", errorText),
        job_url: safeJobUrl(job.html_url),
      });
      continue;
    }
    for (const step of steps) {
      failures.push({
        ...classifyFailure(job.name, step.name || "Unknown failing step", errorText),
        job_url: safeJobUrl(job.html_url),
      });
    }
  }
  const weight = { high: 0, medium: 1, low: 2 };
  return failures.sort((a, b) => weight[a.severity] - weight[b.severity]);
}

function safeLabel(value: string): string {
  return value
    .replace(/[\r\n|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\\`*_{}\x5b\x5d()<>#+.!]/g, "\\$&")
    .slice(0, 140);
}

export function markdownFailureSummary(
  findings: readonly FailedStep[],
  repository: string,
  runId: string
): string {
  const url = `https://github.com/${repository}/actions/runs/${runId}`;
  const rows = findings.slice(0, 20).map((item) => {
    const jobUrl = safeJobUrl(item.job_url);
    const job = jobUrl ? `[${safeLabel(item.job)}](${jobUrl})` : safeLabel(item.job);
    const evidence = item.evidence === "job_log" ? "job log" : item.evidence.replace("_", " ");
    return `| ${job} | ${safeLabel(item.step)} | ${item.kind} / ${item.severity} | ${item.recoverability} | ${evidence} | ${safeLabel(item.recommendation)} |`;
  });
  return [
    "### CI failure triage (informational; cannot override the merge gate)",
    "",
    `[Open the failed run](${url})`,
    "",
    "| Job | Failed step | Category / severity | Recovery | Evidence | Suggested verification |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    ...(findings.length > 20 ? ["", `Further failed steps omitted: ${findings.length - 20}.`] : []),
    ...(!findings.length
      ? ["", "No failed upstream step was visible; inspect the run directly."]
      : []),
    "",
  ].join("\n");
}

const maxJobLogBytes = 8 * 1024 * 1024;
const maxDecodedJobLogBytes = 2 * 1024 * 1024;

/** Read a bounded job log archive and decode it with the runner's standard unzip utility. */
async function readJobLog(repository: string, jobId: number, token: string): Promise<string> {
  let directory: string | undefined;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) return "";
    const announcedBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(announcedBytes) && announcedBytes > maxJobLogBytes) return "";
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) return "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxJobLogBytes) {
        await reader.cancel();
        return "";
      }
      chunks.push(Buffer.from(value));
    }
    if (totalBytes === 0) return "";

    directory = mkdtempSync(join(tmpdir(), "action-worker-ci-log-"));
    const archive = join(directory, "job.zip");
    writeFileSync(archive, Buffer.concat(chunks));
    const decoded = await runCommand("unzip", ["-p", archive], {
      timeoutMs: 15_000,
      maxBuffer: maxDecodedJobLogBytes,
    });
    return decoded.toString("utf8").slice(-maxDecodedJobLogBytes);
  } catch {
    // A missing log must never turn into a guessed root cause or a retry recommendation.
    return "";
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
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

  const logsByJobId = new Map<number, string>();
  const failedJobs = jobs
    .filter(
      (job) => job.id && job.name && job.name !== "validate-merge" && job.conclusion === "failure"
    )
    .slice(0, 20);
  for (const job of failedJobs) {
    const log = await readJobLog(repository, job.id!, token);
    if (log) logsByJobId.set(job.id!, log);
  }

  const findings = summarizeFailures(jobs, logsByJobId);
  appendFileSync(summaryPath, markdownFailureSummary(findings, repository, runId), "utf8");
  // No retry or dispatch is performed here; evidence and recovery classification remain informational.
  console.log(
    `CI triage completed: ${findings.length} failed step(s); merge gate remains unchanged.`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
