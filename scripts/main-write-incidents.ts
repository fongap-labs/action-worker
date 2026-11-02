import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Reader = { get(path: string): Promise<unknown> };
type Issue = Record<string, unknown>;

const prefix = "main write incident:";
const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

function isIncident(value: unknown): value is Issue {
  return (
    isJsonRecord(value) &&
    !isJsonRecord(value.pull_request) &&
    getJsonString(value, "title").toLowerCase().startsWith(prefix) &&
    trustedAssociations.has(getJsonString(value, "author_association").toUpperCase())
  );
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
    const response = await reader.get(
      `repos/${repository}/issues?state=${state}&per_page=100&page=${page}`
    );
    if (!Array.isArray(response)) {
      throw new CliError("::error::Cannot verify main write incidents.", 65);
    }
    incidents.push(...response.filter(isIncident));
    if (response.length < 100) return incidents;
  }
  throw new CliError("::error::Main write incident search exceeded supported pagination.", 65);
}

export async function assertNoOpenMainWriteIncidents(
  reader: Reader,
  repository: string
): Promise<void> {
  const incidents = await findIncidents(reader, repository, "open");
  if (incidents.length === 0) return;
  const numbers = incidents.map((issue) => getJsonNumber(issue, "number")).filter((n) => n > 0);
  throw new CliError(
    `::error::Unresolved main write incident(s) in ${repository}: ${numbers.map((n) => `#${n}`).join(", ") || "unknown issue"}. ` +
      "The latest successful merge cannot clear historical untrusted writes. Review and explicitly resolve the incidents before release, deploy or trusted main attestation.",
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
