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
export function hasExactRepairIssueMarker(
  body: unknown,
  runId: number,
  headSha: string
): boolean {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) {
    return false;
  }
  const markers = [...body.matchAll(MARKER)];
  return markers.length === 1 && Number(markers[0]?.[1]) === runId && markers[0]?.[2] === headSha;
}

/**
 * Resolve an explicitly tagged existing Issue by exact failed Actions run and
 * HEAD SHA. A marker is only an Issue association hint, never root-cause proof.
 * Search all bounded pages before delivering the result; never choose between
 * multiple matching issues or expose Issue bodies in public CI logs.
 */
export async function resolveRepairIssue(
  reader: JsonReader,
  repository: string,
  runId: number,
  headSha: string
): Promise<number | null> {
  if (
    repository !== repository.toLowerCase() ||
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !HEAD_SHA.test(headSha)
  ) {
    throw new CliError("Repair Issue lookup has invalid failure identity.", 65);
  }

  let match: number | null = null;
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
      // GitHub's Issues API also lists pull requests. They are never admissible.
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
      if (!marker || Number(marker[1]) !== runId || marker[2] !== headSha) continue;
      if (match !== null) {
        throw new CliError("Multiple Issues match the same failed Actions run.", 75);
      }
      match = number;
    }
    if (response.length < PAGE_SIZE) return match;
  }
  throw new CliError("Repair Issue scan exceeded the bounded page budget.", 75);
}
