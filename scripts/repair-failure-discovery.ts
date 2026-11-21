import type { JsonReader } from "./ci-evidence.ts";
import { GithubReader, getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError, isMain } from "./runtime-command.ts";

const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const OWNER = /^[a-z0-9-]{1,39}$/;
const SHA = /^[a-f0-9]{40}$/;
const PAGE_SIZE = 100;
const MAX_REPOSITORIES = 500;
const MAX_FAILURES_PER_STATUS = 300;
// Limit in-memory candidates before an entire organization scan has been certified.
const MAX_CANDIDATES_PER_SCAN = 3_000;
const CONCLUSIONS = ["failure", "timed_out"] as const;

export interface FailedRunCandidate {
  readonly repository: string;
  readonly is_private: boolean;
  readonly run_id: number;
  readonly head_sha: string;
  readonly conclusion: (typeof CONCLUSIONS)[number];
  readonly created_at: string;
  readonly workflow_path: string;
}

export interface DiscoverySummary {
  readonly repositories_scanned: number;
  readonly failures_found: number;
}

type InstalledRepository = {
  readonly name: string;
  readonly is_private: boolean;
};

function safeCount(value: unknown, limit: number): number {
  if (!isJsonRecord(value) || typeof value.total_count !== "number") {
    throw new CliError("Invalid GitHub discovery response.", 65);
  }
  const count = getJsonNumber(value, "total_count");
  if (!Number.isSafeInteger(count) || count < 0 || count > limit) {
    throw new CliError("GitHub discovery exceeds its bounded scan budget.", 75);
  }
  return count;
}

function pageItems(value: unknown, field: string): unknown[] {
  const items = isJsonRecord(value) ? value[field] : undefined;
  if (!Array.isArray(items) || items.length > PAGE_SIZE) {
    throw new CliError("Invalid GitHub discovery page.", 65);
  }
  return items;
}

async function installedRepositories(
  reader: JsonReader,
  owner: string
): Promise<InstalledRepository[]> {
  const repositories: InstalledRepository[] = [];
  let expectedCount: number | null = null;
  const names = new Set<string>();
  for (let page = 1; page <= Math.ceil(MAX_REPOSITORIES / PAGE_SIZE) + 1; page += 1) {
    const result = await reader.get(`installation/repositories?per_page=${PAGE_SIZE}&page=${page}`);
    const total = safeCount(result, MAX_REPOSITORIES);
    if (expectedCount !== null && total !== expectedCount) {
      throw new CliError("GitHub App installation inventory changed during discovery.", 75);
    }
    expectedCount = total;
    const items = pageItems(result, "repositories");
    if (names.size + items.length > total) {
      throw new CliError("GitHub App inventory page count is inconsistent.", 65);
    }
    for (const item of items) {
      if (
        !isJsonRecord(item) ||
        typeof item.private !== "boolean" ||
        typeof item.archived !== "boolean" ||
        typeof item.disabled !== "boolean"
      ) {
        throw new CliError("GitHub App installation repository metadata is invalid.", 65);
      }
      const name = getJsonString(item, "full_name").toLowerCase();
      const repoOwner = getJsonString(item.owner, "login").toLowerCase();
      if (!REPOSITORY.test(name) || repoOwner !== owner || !name.startsWith(`${owner}/`)) {
        throw new CliError("GitHub App inventory includes an invalid repository scope.", 77);
      }
      if (names.has(name)) throw new CliError("Duplicate GitHub App repository in inventory.", 65);
      names.add(name);
      if (!item.archived && !item.disabled) {
        repositories.push({ name, is_private: item.private });
      }
    }
    if (names.size === total) return repositories;
    if (items.length !== PAGE_SIZE) {
      throw new CliError("GitHub App inventory was truncated before the final page.", 75);
    }
  }
  throw new CliError("GitHub App installation inventory pagination exhausted.", 75);
}

async function scanFailures(
  reader: JsonReader,
  repository: InstalledRepository,
  since: string,
  onCandidate: (candidate: FailedRunCandidate) => Promise<void> | void
): Promise<number> {
  let count = 0;
  const observed = new Set<number>();
  for (const conclusion of CONCLUSIONS) {
    let expectedCount: number | null = null;
    let received = 0;
    const created = encodeURIComponent(`>=${since}`);
    for (let page = 1; page <= Math.ceil(MAX_FAILURES_PER_STATUS / PAGE_SIZE); page += 1) {
      const result = await reader.get(
        `repos/${repository.name}/actions/runs?status=${conclusion}&created=${created}&per_page=${PAGE_SIZE}&page=${page}`
      );
      const total = safeCount(result, MAX_FAILURES_PER_STATUS);
      if (expectedCount !== null && total !== expectedCount) {
        throw new CliError("GitHub workflow inventory changed during discovery.", 75);
      }
      expectedCount = total;
      const runs = pageItems(result, "workflow_runs");
      if (received + runs.length > total) {
        throw new CliError("GitHub workflow inventory page count is inconsistent.", 65);
      }
      for (const run of runs) {
        if (!isJsonRecord(run)) {
          throw new CliError("GitHub discovery workflow result is invalid.", 65);
        }
        const id = getJsonNumber(run, "id");
        const headSha = getJsonString(run, "head_sha");
        const source = getJsonString(run.repository, "full_name").toLowerCase();
        const createdAt = getJsonString(run, "created_at");
        const path = getJsonString(run, "path");
        if (
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          !SHA.test(headSha) ||
          source !== repository.name ||
          getJsonString(run, "conclusion") !== conclusion ||
          getJsonString(run, "status") !== "completed" ||
          !path.startsWith(".github/workflows/") ||
          !/\.ya?ml$/.test(path) ||
          !Number.isFinite(Date.parse(createdAt)) ||
          Date.parse(createdAt) < Date.parse(since)
        ) {
          throw new CliError("GitHub discovery failure run has inconsistent provenance.", 75);
        }
        if (observed.has(id)) {
          throw new CliError("Duplicate GitHub workflow run in discovery pages.", 75);
        }
        observed.add(id);
        await onCandidate({
          repository: repository.name,
          is_private: repository.is_private,
          run_id: id,
          head_sha: headSha,
          conclusion,
          created_at: createdAt,
          workflow_path: path,
        });
        count += 1;
      }
      received += runs.length;
      if (received === total) break;
      if (runs.length !== PAGE_SIZE || page === Math.ceil(MAX_FAILURES_PER_STATUS / PAGE_SIZE)) {
        throw new CliError("GitHub workflow inventory is incomplete.", 75);
      }
    }
  }
  return count;
}

/**
 * Enumerate currently GitHub-App-accessible repositories without a maintained
 * repo list. Failures are candidates, not verified root causes. Never print
 * private repository or run identifiers in public logs.
 */
export async function discoverFailedRuns(
  reader: JsonReader,
  owner: string,
  since: string,
  onCandidate: (candidate: FailedRunCandidate) => Promise<void> | void
): Promise<DiscoverySummary> {
  const normalizedOwner = owner.trim().toLowerCase();
  if (
    !OWNER.test(normalizedOwner) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(since) ||
    !Number.isFinite(Date.parse(since))
  ) {
    throw new CliError("Repair discovery scope or UTC cutoff is invalid.", 65);
  }
  const repositories = await installedRepositories(reader, normalizedOwner);
  // Discovery must be fail-closed as a batch. Never admit a candidate while
  // another repository or results page may still fail with 403, quota errors,
  // inconsistent inventory or an incomplete page. This prevents the upcoming
  // durable-ledger admission step from observing an uncertified partial scan.
  const candidates: FailedRunCandidate[] = [];
  for (const repository of repositories) {
    await scanFailures(reader, repository, since, (candidate) => {
      if (candidates.length >= MAX_CANDIDATES_PER_SCAN) {
        throw new CliError("Repair discovery candidate budget exceeded; no scan is certified.", 75);
      }
      candidates.push(candidate);
    });
  }
  // Callback side effects are outside discovery's transaction boundary.
  // At this point every scanned repository and page has been validated.
  for (const candidate of candidates) {
    await onCandidate(candidate);
  }
  return { repositories_scanned: repositories.length, failures_found: candidates.length };
}

async function main(): Promise<void> {
  const control = process.env.GITHUB_REPOSITORY ?? "";
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? "";
  const token = process.env.AW_INVENTORY_TOKEN ?? "";
  if (
    control !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "schedule" ||
    !token
  ) {
    throw new CliError("Repair discovery requires trusted main and an App inventory token.", 77);
  }
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token, {
    attemptLimit: 2,
  });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const summary = await discoverFailedRuns(reader, owner, since, () => undefined);
  console.log(JSON.stringify(summary));
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    // Public control logs must not include private repository or run paths,
    // even when the API reports a 403 or times out.
    console.error("::error::Repair discovery did not complete; no inventory is certified.");
    process.exitCode = 1;
  });
}
