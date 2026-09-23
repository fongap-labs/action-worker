import { access, readFile, writeFile } from "node:fs/promises";
import {
  GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

export type WorkCounts = {
  dispatch: number;
  pr_governance: number;
  ai_review: number;
  gate: number;
  release_governance: number;
};

type IncrementCounts = Omit<WorkCounts, "gate">;
const JOB_READ_LIMIT = 4;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError("Concurrency limit must be a positive integer.");
  }
  const results = new Array<R>(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function getApiArray(value: unknown, key?: string): unknown[] {
  return getJsonArray(value, key, 77);
}

function addRepository(repositories: string[], repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError(`Invalid repository name: ${repository}`, 65);
  }
  if (!repositories.includes(repository)) {
    repositories.push(repository);
  }
}

function parseRepositories(value: string): string[] {
  const parsed = parseJson(
    value,
    "METRICS_REPOSITORIES_JSON must be a JSON array of owner/repository values.",
  );
  if (
    !Array.isArray(parsed)
    || !parsed.every((item) => typeof item === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item))
  ) {
    throw new CliError(
      "METRICS_REPOSITORIES_JSON must be a JSON array of owner/repository values.",
      65,
    );
  }
  return parsed;
}

async function discoverRepos(
  reader: GithubReader,
  repository: string,
  owner: string,
  configured: string,
  hasToken: boolean,
): Promise<string[]> {
  const repositories: string[] = [];
  addRepository(repositories, repository);
  if (configured) {
    for (const item of parseRepositories(configured)) {
      addRepository(repositories, item);
    }
    return repositories;
  }

  for (let page = 1; ; page += 1) {
    const response = getApiArray(await reader.get(`users/${owner}/repos?type=owner&per_page=100&page=${page}`));
    for (const item of response) {
      addRepository(repositories, getJsonString(item, "full_name"));
    }
    if (response.length < 100) {
      break;
    }
  }

  if (hasToken) {
    for (let page = 1; ; page += 1) {
      let response: unknown[];
      try {
        response = getApiArray(await reader.get(`user/repos?affiliation=owner&per_page=100&page=${page}`));
      } catch {
        console.error("::warning::Current metrics credential cannot enumerate private repositories; only accessible repositories will be counted.");
        break;
      }
      for (const item of response) {
        if (isJsonRecord(item) && isJsonRecord(item.owner) && item.owner.login === owner) {
          addRepository(repositories, getJsonString(item, "full_name"));
        }
      }
      if (response.length < 100) {
        break;
      }
    }
  }
  return repositories;
}

export function isSuccessfulRun(value: unknown, path: string): boolean {
  return isJsonRecord(value)
    && value.path === path
    && value.event === "repository_dispatch"
    && value.conclusion === "success";
}

function hasSuccessfulStep(value: unknown, name: string): boolean {
  const jobs = getApiArray(value, "jobs");
  return jobs.some((job) => {
    if (!isJsonRecord(job) || !Array.isArray(job.steps)) {
      return false;
    }
    return job.steps.some((step) => isJsonRecord(step) && step.name === name && step.conclusion === "success");
  });
}

async function collectMetrics(
  reader: GithubReader,
  repository: string,
  owner: string,
  configured: string,
  hasToken: boolean,
): Promise<{ counts: WorkCounts; repositories: number }> {
  const repositories = await discoverRepos(reader, repository, owner, configured, hasToken);
  const counts: WorkCounts = {
    dispatch: 0,
    pr_governance: 0,
    ai_review: 0,
    gate: 0,
    release_governance: 0,
  };

  for (const current of repositories) {
    for (let page = 1; ; page += 1) {
      let response: unknown;
      try {
        response = await reader.get(`repos/${current}/actions/runs?per_page=100&page=${page}`);
      } catch {
        throw new CliError(`Unable to read Actions runs for ${current}.`, 77);
      }
      const runs = getApiArray(response, "workflow_runs");
      if (current === repository) {
        counts.dispatch += runs.filter((run) => isSuccessfulRun(
          run,
          ".github/workflows/handle-task-dispatch.yml",
        )).length;
        const governanceRuns = runs.filter((run) => isSuccessfulRun(
          run,
          ".github/workflows/handle-pr-dispatch.yml",
        ));
        counts.pr_governance += governanceRuns.length;
        counts.release_governance += runs.filter((run) => isSuccessfulRun(
          run,
          ".github/workflows/handle-release-dispatch.yml",
        )).length;

        const runIds = governanceRuns
          .map((run) => getJsonNumber(run, "id"))
          .filter((runId) => runId > 0);
        const jobPages = await mapWithLimit(runIds, JOB_READ_LIMIT, async (runId) => (
          await reader.get(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`)
        ));
        for (const jobs of jobPages) {
          if (hasSuccessfulStep(jobs, "Run AI review")) {
            counts.ai_review += 1;
          }
          if (hasSuccessfulStep(jobs, "Update final gate")) {
            counts.gate += 1;
          }
        }
      }
      if (runs.length < 100) {
        break;
      }
    }
  }
  return { counts, repositories: repositories.length };
}

export function parseFixture(value: string): WorkCounts {
  const parsed = parseJson(value, "WORK_METRICS_COUNTS is invalid.");
  if (
    !isJsonRecord(parsed)
    || !isCount(parsed.dispatch)
    || !isCount(parsed.pr_governance)
    || !isCount(parsed.ai_review)
    || !isCount(parsed.gate)
    || !isCount(parsed.release_governance)
  ) {
    throw new CliError("WORK_METRICS_COUNTS is invalid.", 65);
  }
  return parsed as WorkCounts;
}

function parseIncrement(value: string): IncrementCounts {
  const parsed = parseJson(value, "WORK_METRICS_JSON is invalid.");
  if (!isJsonRecord(parsed)) {
    throw new CliError("WORK_METRICS_JSON is invalid.", 65);
  }
  const keys = ["dispatch", "pr_governance", "ai_review", "release_governance"] as const;
  for (const key of keys) {
    const count = parsed[key] ?? 0;
    if (!isCount(count)) {
      throw new CliError("WORK_METRICS_JSON is invalid.", 65);
    }
  }
  return {
    dispatch: (parsed.dispatch as number | undefined) ?? 0,
    pr_governance: (parsed.pr_governance as number | undefined) ?? 0,
    ai_review: (parsed.ai_review as number | undefined) ?? 0,
    release_governance: (parsed.release_governance as number | undefined) ?? 0,
  };
}

function readBadge(content: string, label: string): number {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`img\\.shields\\.io/badge/${escaped}-([0-9%2C]+)-`));
  if (!match?.[1]) {
    throw new CliError(`README metric badge not found: ${label}`);
  }
  const decoded = decodeURIComponent(match[1]).replaceAll(",", "");
  if (!/^\d+$/.test(decoded)) {
    throw new CliError(`README metric value is invalid: ${label}=${decoded}`);
  }
  return Number(decoded);
}

export function applyIncrement(content: string, increment: IncrementCounts): WorkCounts {
  const dispatch = readBadge(content, "Task%20Dispatch") + increment.dispatch;
  const governance = readBadge(content, "PR%20Governance") + increment.pr_governance;
  const aiReview = readBadge(content, "AI%20Review") + increment.ai_review;
  const release = readBadge(content, "Release%20Governance") + increment.release_governance;
  return {
    dispatch,
    pr_governance: governance,
    ai_review: aiReview,
    gate: governance,
    release_governance: release,
  };
}

function badgeValue(value: number): string {
  return encodeURIComponent(value.toLocaleString("en-US"));
}

export function renderMetrics(content: string, counts: WorkCounts, repository: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  const block = `<!-- work-metrics:start -->
[![Task Dispatch](https://img.shields.io/badge/Task%20Dispatch-${badgeValue(counts.dispatch)}-1d76db?style=flat-square)](https://github.com/${repository}/actions) [![AI Review](https://img.shields.io/badge/AI%20Review-${badgeValue(counts.ai_review)}-006b75?style=flat-square)](https://github.com/${repository}/actions) [![PR Governance](https://img.shields.io/badge/PR%20Governance-${badgeValue(counts.pr_governance)}-0052cc?style=flat-square)](https://github.com/${repository}/actions) [![Release Governance](https://img.shields.io/badge/Release%20Governance-${badgeValue(counts.release_governance)}-0e8a16?style=flat-square)](https://github.com/${repository}/releases) [![Status](https://img.shields.io/github/actions/workflow/status/${repository}/validate-ci.yml?branch=main&style=flat-square&label=Status)](https://github.com/${repository}/actions/workflows/validate-ci.yml)
<!-- work-metrics:end -->`;
  const pattern = /<!-- work-metrics:start -->.*?<!-- work-metrics:end -->/s;
  if (!pattern.test(normalized)) {
    throw new CliError("README work metrics markers were not found.");
  }
  return normalized.replace(pattern, () => block);
}

async function main(): Promise<void> {
  const readmePaths = process.argv.slice(2);
  const targets = readmePaths.length > 0 ? readmePaths : ["README.md"];
  const primaryReadmePath = targets[0]!;
  for (const readmePath of targets) {
    try {
      await access(readmePath);
    } catch {
      throw new CliError(`README not found: ${readmePath}`, 66);
    }
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "fongap/action-worker";
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repository.split("/", 1)[0] ?? "";
  const token = process.env.METRICS_TOKEN ?? "";
  const configured = process.env.METRICS_REPOSITORIES_JSON ?? "";
  const fixtureJson = process.env.WORK_METRICS_COUNTS ?? "";
  const incrementJson = process.env.WORK_METRICS_JSON ?? "";
  const content = await readFile(primaryReadmePath, "utf8");
  let counts: WorkCounts;
  let repositoryCount = 0;

  if (fixtureJson) {
    counts = parseFixture(fixtureJson);
  } else if (incrementJson) {
    counts = applyIncrement(content, parseIncrement(incrementJson));
  } else {
    const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
    const result = await collectMetrics(reader, repository, owner, configured, Boolean(token));
    counts = result.counts;
    repositoryCount = result.repositories;
  }

  for (const readmePath of targets) {
    const targetContent = readmePath === primaryReadmePath
      ? content
      : await readFile(readmePath, "utf8");
    await writeFile(readmePath, renderMetrics(targetContent, counts, repository), "utf8");
  }
  await appendLines(process.env.GITHUB_OUTPUT, [
    `dispatch=${counts.dispatch}`,
    `pr_governance=${counts.pr_governance}`,
    `ai_review=${counts.ai_review}`,
    `gate=${counts.gate}`,
    `release_governance=${counts.release_governance}`,
  ]);
  const summary = [
    "## Work Metrics",
    "",
    `- Task Dispatch: ${counts.dispatch}`,
    `- PR Governance: ${counts.pr_governance}`,
    `- AI Review: ${counts.ai_review}`,
    `- Gate: ${counts.gate}`,
    `- Release Governance: ${counts.release_governance}`,
    incrementJson ? "- Mode: incremental" : `- Repositories: ${repositoryCount}`,
  ];
  await appendLines(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(
    `Task Dispatch=${counts.dispatch} PR Governance=${counts.pr_governance} AI Review=${counts.ai_review} Gate=${counts.gate} Release Governance=${counts.release_governance}`,
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
