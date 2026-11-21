import type { JsonReader } from "./ci-evidence.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const HEAD_SHA = /^[a-f0-9]{40}$/;
const PAGE_SIZE = 100;
const MAX_ISSUE_PAGES = 5;
const MAX_ISSUE_BODY_BYTES = 65_536;
const MARKER = /^<!-- aw-repair-failure:v1 run=([1-9][0-9]*) sha=([a-f0-9]{40}) -->$/gm;

/**
 * Recheck the exact marker on the fresh Issue response immediately before
 * persisting the binding. A stale match must not survive a modified Issue.
 */
export function hasExactRepairIssueMarker(body: unknown, runId: number, headSha: string): boolean {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) {
    return false;
  }
  const markers = [...body.matchAll(MARKER)];
  return markers.length === 1 && Number(markers[0]?.[1]) === runId && markers[0]?.[2] === headSha;
}

export interface RepairIssueFailureIdentity {
  readonly run_id: number;
  readonly head_sha: string;
}

export interface RepairIssueLink extends RepairIssueFailureIdentity {
  readonly issue_number: number;
}

/**
 * Read open Issues only once for a bounded batch of genuine failed-run identities.
 * Do not return partial links if any later page, duplicate or permission check fails.
 * Issue markers are routing hints, not verified diagnoses.
 */
export async function resolveRepairIssueLinks(
  reader: JsonReader,
  repository: string,
  failures: readonly RepairIssueFailureIdentity[]
): Promise<RepairIssueLink[]> {
  if (
    repository !== repository.toLowerCase() ||
    !REPOSITORY.test(repository) ||
    failures.length > 600
  ) {
    throw new CliError("Repair Issue lookup has invalid failure identity.", 65);
  }
  const expected = new Map<number, string>();
  for (const failure of failures) {
    if (
      !Number.isSafeInteger(failure.run_id) ||
      failure.run_id <= 0 ||
      !HEAD_SHA.test(failure.head_sha) ||
      expected.has(failure.run_id)
    ) {
      throw new CliError("Repair Issue lookup has invalid failure identity.", 65);
    }
    expected.set(failure.run_id, failure.head_sha);
  }
  if (expected.size === 0) return [];

  const links = new Map<number, RepairIssueLink>();
  const seenIssues = new Set<number>();
  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const response = await reader.get(
      `repos/${repository}/issues?state=open&per_page=${PAGE_SIZE}&page=${page}`
    );
    if (!Array.isArray(response) || response.length > PAGE_SIZE) {
      throw new CliError("Repair Issue listing is invalid.", 65);
    }
    for (const issue of response) {
      if (!isJsonRecord(issue)) {
        throw new CliError("Repair Issue metadata is invalid.", 65);
      }
      const number = getJsonNumber(issue, "number");
      if (
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        getJsonString(issue, "state") !== "open" ||
        seenIssues.has(number)
      ) {
        throw new CliError("Repair Issue listing has inconsistent identity.", 75);
      }
      seenIssues.add(number);
      if (issue.pull_request !== undefined) continue;
      const body = issue.body;
      if (body === null || body === undefined) continue;
      if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) {
        throw new CliError("Repair Issue marker source is invalid.", 65);
      }
      const markers = [...body.matchAll(MARKER)];
      if (markers.length > 1) {
        throw new CliError("Repair Issue contains ambiguous failure markers.", 75);
      }
      const marker = markers[0];
      if (!marker) continue;
      const runId = Number(marker[1]);
      if (!Number.isSafeInteger(runId) || runId <= 0) {
        throw new CliError("Repair Issue marker identity is invalid.", 65);
      }
      if (expected.get(runId) !== marker[2]) continue;
      if (links.has(runId)) {
        throw new CliError("Multiple Issues match the same failed Actions run.", 75);
      }
      links.set(runId, { run_id: runId, head_sha: marker[2]!, issue_number: number });
    }
    if (response.length < PAGE_SIZE) {
      return [...links.values()].sort((a, b) => a.run_id - b.run_id);
    }
  }
  throw new CliError("Repair Issue scan exceeded the bounded page budget.", 75);
}

/** Resolve one Issue via the same batch validator; never choose ambiguous matches. */
export async function resolveRepairIssue(
  reader: JsonReader,
  repository: string,
  runId: number,
  headSha: string
): Promise<number | null> {
  const matches = await resolveRepairIssueLinks(reader, repository, [
    { run_id: runId, head_sha: headSha },
  ]);
  return matches[0]?.issue_number ?? null;
}
