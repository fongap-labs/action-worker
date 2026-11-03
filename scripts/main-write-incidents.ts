import { GithubHttpError, getJsonNumber, getJsonString, isJsonRecord, runGithubCli } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Reader = { get(path: string): Promise<unknown> };
type Issue = Record<string, unknown>;

const prefix = "main write incident:";
const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

// Default TTL for main write incidents: 14 days
// After this period, an incident is considered auto-expired and no longer blocks the pipeline.
// A maintainer can resolve an incident early by commenting "/resolve" on the issue.
const DEFAULT_TTL_DAYS = 14;
const RESOLVE_COMMENT = "/resolve";

export class IncidentAccessError extends CliError {
  constructor(repository: string, status: number) {
    super(
      `::error::Cannot inspect main write incidents in ${repository}: GitHub API HTTP ${status}. Check that AW_CONTROL_TOKEN has access to this repository and Issues: read and write. The main write audit cannot pass without reading unresolved incidents.`,
      77
    );
  }
}

function isIncident(value: unknown): value is Issue {
  return (
    isJsonRecord(value) &&
    !isJsonRecord(value.pull_request) &&
    getJsonString(value, "title").toLowerCase().startsWith(prefix) &&
    trustedAssociations.has(getJsonString(value, "author_association").toUpperCase())
  );
}

function isExpired(issue: Issue): boolean {
  const createdAt = getJsonString(issue, "created_at");
  if (!createdAt) return false;
  const created = new Date(createdAt);
  const expiry = new Date(created.getTime() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);
  return new Date() > expiry;
}

async function isResolvedByComment(
  reader: Reader,
  repository: string,
  issueNumber: number
): Promise<boolean> {
  try {
    const comments = await reader.get(
      `repos/${repository}/issues/${issueNumber}/comments?per_page=100`
    );
    if (!Array.isArray(comments)) return false;
    return comments.some(
      (comment) =>
        isJsonRecord(comment) &&
        getJsonString(comment, "body").trim() === RESOLVE_COMMENT &&
        trustedAssociations.has(getJsonString(comment, "author_association").toUpperCase())
    );
  } catch {
    return false;
  }
}

export async function findIncidents(
  reader: Reader,
  repository: string,
  state: "open" | "all"
): Promise<Issue[]> {
  if (!repositoryPattern.test(repository)) {
    throw new CliError("::error::Invalid incident repository.", 65);
  }
  const incidents: Issue[] = [];
  for (let page = 1; page <= 10; page += 1) {
    let response: unknown;
    try {
      response = await reader.get(
        `repos/${repository}/issues?state=${state}&per_page=100&page=${page}`
      );
    } catch (error) {
      if (error instanceof GithubHttpError && (error.status === 403 || error.status === 404)) {
        throw new IncidentAccessError(repository, error.status);
      }
      throw error;
    }
    if (!Array.isArray(response)) {
      throw new CliError("::error::Cannot verify main write incidents.", 65);
    }
    incidents.push(...response.filter(isIncident));
    if (response.length < 100) return incidents;
  }
  throw new CliError("::error::Main write incident search exceeded supported pagination.", 65);
}

// Returns only incidents that are open, not expired, and not resolved by a maintainer comment.
export async function findActiveIncidents(
  reader: Reader,
  repository: string
): Promise<Issue[]> {
  const openIncidents = await findIncidents(reader, repository, "open");
  const active: Issue[] = [];
  for (const incident of openIncidents) {
    if (isExpired(incident)) continue;
    const number = getJsonNumber(incident, "number");
    if (number > 0 && await isResolvedByComment(reader, repository, number)) continue;
    active.push(incident);
  }
  return active;
}

export async function assertNoOpenMainWriteIncidents(
  reader: Reader,
  repository: string
): Promise<void> {
  const incidents = await findActiveIncidents(reader, repository);
  if (incidents.length === 0) return;
  const numbers = incidents.map((issue) => getJsonNumber(issue, "number")).filter((n) => n > 0);
  const expired = (await findIncidents(reader, repository, "open")).filter(isExpired);
  const expiredNote = expired.length > 0
    ? ` ${expired.length} expired incident(s) will be auto-closed.`
    : "";
  throw new CliError(
    `::error::Unresolved main write incident(s) in ${repository}: ${numbers.map((n) => `#${n}`).join(", ") || "unknown issue"}. ` +
      "The latest successful merge cannot clear historical untrusted writes. Review and explicitly resolve the incidents before release, deploy or trusted main attestation. " +
      `To resolve early, comment /resolve on the incident issue. Incidents auto-expire after ${DEFAULT_TTL_DAYS} days.${expiredNote}`,
    65
  );
}

export function incidentTitle(sha: string): string {
  if (!shaPattern.test(sha)) {
    throw new CliError("::error::Invalid main write incident SHA.", 65);
  }
  return `Main write incident: ${sha.slice(0, 12)}`;
}

export async function shouldCreateIncident(
  reader: Reader,
  repository: string,
  sha: string
): Promise<boolean> {
  const title = incidentTitle(sha);
  const incidents = await findIncidents(reader, repository, "all");
  return !incidents.some((incident) => getJsonString(incident, "title") === title);
}

// Closes incidents that have expired (older than DEFAULT_TTL_DAYS).
// Returns the number of incidents closed.
export async function closeExpiredIncidents(
  reader: Reader,
  repository: string,
  token: string
): Promise<number> {
  if (!repositoryPattern.test(repository)) {
    throw new CliError("::error::Invalid incident repository.", 65);
  }
  const allIncidents = await findIncidents(reader, repository, "open");
  const expired = allIncidents.filter(isExpired);
  let closed = 0;
  for (const incident of expired) {
    const number = getJsonNumber(incident, "number");
    if (number <= 0) continue;
    try {
      await runGithubCli(
        ["api", "--method", "PATCH", `repos/${repository}/issues/${number}`, "-f", "state=closed", "-f", "state_reason=completed"],
        token
      );
      console.log(`Auto-closed expired main write incident #${number} in ${repository}`);
      closed += 1;
    } catch (error) {
      console.error(`Failed to close expired incident #${number} in ${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return closed;
}
