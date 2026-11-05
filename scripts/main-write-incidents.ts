import { GithubHttpError, getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Reader = { get(path: string): Promise<unknown> };
type Issue = Record<string, unknown>;

const prefix = "main write incident:";
const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// GitHub App issue authors have author_association=NONE even inside managed repositories.
const trustedAutomationLogin = "fongap-action-worker[bot]";
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

// Incidents remain blocking until a trusted maintainer explicitly resolves them.
// A newer successful merge never retroactively validates an untrusted main write.
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
  if (!isJsonRecord(value) || isJsonRecord(value.pull_request)) return false;
  if (!getJsonString(value, "title").toLowerCase().startsWith(prefix)) return false;
  const association = getJsonString(value, "author_association").toUpperCase();
  if (trustedAssociations.has(association)) return true;
  return (
    getJsonString(value.user, "login") === trustedAutomationLogin &&
    getJsonString(value.user, "type") === "Bot"
  );
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

// Returns open incidents that have not been explicitly resolved by a trusted comment.
export async function findActiveIncidents(reader: Reader, repository: string): Promise<Issue[]> {
  const openIncidents = await findIncidents(reader, repository, "open");
  const active: Issue[] = [];
  for (const incident of openIncidents) {
    const number = getJsonNumber(incident, "number");
    if (number > 0 && (await isResolvedByComment(reader, repository, number))) continue;
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
  throw new CliError(
    `::error::Unresolved main write incident(s) in ${repository}: ${numbers.map((n) => `#${n}`).join(", ") || "unknown issue"}. ` +
      "The latest successful merge cannot clear historical untrusted writes. Review the evidence, record maintainer approval, then explicitly resolve each incident before release, deploy or trusted main attestation. " +
      "To resolve, comment /resolve on the incident issue after the decision is documented. Incidents never auto-expire.",
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
