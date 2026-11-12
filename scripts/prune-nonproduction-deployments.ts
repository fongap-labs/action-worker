import {
  GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

type Deployment = { id: number; environment: string; createdAt: number };

const repository = "fongap-labs/action-worker";
const pageSize = 100;
const maxScanPages = 200;
// Two runs per hour: at most 240 removals / 480 status-and-delete writes per hour.
const maxDeletionsPerRun = 120;
const gracePeriodMs = 60 * 60 * 1000;

/** Reject malformed API records rather than risking a wrong deletion. */
export function nonProductionDeployments(records: unknown): Deployment[] {
  return getJsonArray(records)
    .map((value) => {
      if (!isJsonRecord(value)) {
        throw new CliError("Invalid GitHub Deployment record.", 65);
      }
      const id = getJsonNumber(value, "id");
      const environment = getJsonString(value, "environment");
      const createdAt = Date.parse(getJsonString(value, "created_at"));
      if (!Number.isSafeInteger(id) || id <= 0 || !environment || !Number.isFinite(createdAt)) {
        throw new CliError("GitHub Deployment record is missing required fields.", 65);
      }
      return { id, environment, createdAt };
    })
    .filter((item) => item.environment !== "production");
}

async function listCandidates(reader: GithubReader): Promise<Deployment[]> {
  const deployments: Deployment[] = [];
  for (let page = 1; page <= maxScanPages; page += 1) {
    const records = getJsonArray(
      await reader.get(`repos/${repository}/deployments?per_page=${pageSize}&page=${page}`)
    );
    deployments.push(...nonProductionDeployments(records));
    if (records.length < pageSize) return deployments;
  }
  throw new CliError("Deployment inventory exceeds the safe pagination limit.", 65);
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? "";
  if (
    !token ||
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new CliError("Deployment history pruning requires the trusted control main.", 77);
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL || "https://api.github.com", token);
  const candidates = await listCandidates(reader);
  const now = Date.now();
  let removed = 0;
  let deferred = 0;
  for (const deployment of candidates) {
    // Allow an in-flight deployment to complete; only old history is retired.
    if (now - deployment.createdAt < gracePeriodMs || removed >= maxDeletionsPerRun) {
      deferred += 1;
      continue;
    }
    const path = `repos/${repository}/deployments/${deployment.id}`;
    // GitHub only allows deletion of inactive Deployments. This changes the record,
    // not the runtime environment, its Secrets, Variables or protection rules.
    await runGithubCli(
      ["api", "--method", "POST", `${path}/statuses`, "-f", "state=inactive"],
      token
    );
    await runGithubCli(["api", "--method", "DELETE", path], token);
    removed += 1;
  }

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Production-only Deployment history",
    "",
    `- Preserved: all production Deployment records`,
    `- Removed: ${removed} non-production Deployment records`,
    `- Deferred: ${deferred} (recent or beyond the per-run budget)`,
    "- Environments, Secrets, Variables and protection rules were not changed.",
  ]);
  console.log(`Pruned ${removed} non-production Deployment records; ${deferred} deferred.`);
}

if (isMain(import.meta.url)) main().catch(handleError);
