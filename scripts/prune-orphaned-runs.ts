import { existsSync } from "node:fs";
import {
  GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

type OrphanedWorkflow = { id: number; name: string; path: string };

type PruneResult = { name: string; path: string; deleted: number; result: string };

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowPathPattern = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

// A removed workflow keeps its runs for this long, so a reverted removal still has its history.
export const gracePeriodMs = 2 * 24 * 60 * 60 * 1000;
// The workflow token allows 1000 API requests an hour; each deletion is one request.
export const maxDeletionsPerRun = 400;

/**
 * GitHub keeps a workflow in the Actions sidebar while it has runs, even after its file is gone.
 * Only workflow files are considered: dynamic workflows (Dependabot, code scanning) have no file.
 */
export function orphanedWorkflows(
  workflows: unknown,
  fileExists: (path: string) => boolean
): OrphanedWorkflow[] {
  return getJsonArray(workflows, "workflows")
    .filter(isJsonRecord)
    .map((item) => ({
      id: getJsonNumber(item, "id"),
      name: getJsonString(item, "name"),
      path: getJsonString(item, "path"),
    }))
    .filter((item) => item.id > 0 && workflowPathPattern.test(item.path) && !fileExists(item.path));
}

// The newest run decides: a workflow removed within the grace period keeps every run.
export function isPastGracePeriod(latestRun: unknown, nowMs: number): boolean {
  const updatedAt = Date.parse(getJsonString(latestRun, "updated_at"));
  return Number.isFinite(updatedAt) && nowMs - updatedAt > gracePeriodMs;
}

export function isDeletableRun(run: unknown): boolean {
  return getJsonString(run, "status") === "completed" && getJsonNumber(run, "id") > 0;
}

// The run log of a failed request must name the request, so the refused call is visible.
export function describeRequestFailure(path: string, error: unknown): CliError {
  const reason = error instanceof Error ? error.message : String(error);
  return new CliError(`::error::GitHub request failed for ${path}: ${reason}`, 1);
}

async function getOrFail(reader: GithubReader, path: string): Promise<unknown> {
  try {
    return await reader.get(path);
  } catch (error) {
    throw describeRequestFailure(path, error);
  }
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? "";
  if (!token || !repositoryPattern.test(repository)) {
    throw new CliError("::error::GH_TOKEN and GITHUB_REPOSITORY are required.", 77);
  }
  // Every workflow file is read from this checkout, so it must be main. If the running workflow's
  // own file is missing, the checkout is wrong and every workflow would look removed.
  if (process.env.GITHUB_REF !== "refs/heads/main") {
    throw new CliError("::error::Orphaned runs are pruned only from a checkout of main.", 64);
  }
  const ownPath = workflowRef.replace(`${repository}/`, "").replace(/@.*$/, "");
  if (!workflowPathPattern.test(ownPath) || !existsSync(ownPath)) {
    throw new CliError(
      `::error::The running workflow file is not in this checkout: ${ownPath}.`,
      65
    );
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const orphaned = orphanedWorkflows(
    await getOrFail(reader, `repos/${repository}/actions/workflows?per_page=100`),
    existsSync
  );
  const nowMs = Date.now();
  const results: PruneResult[] = [];
  let budget = maxDeletionsPerRun;

  for (const workflow of orphaned) {
    const result: PruneResult = { ...workflow, deleted: 0, result: "" };
    results.push(result);
    const runsPath = `repos/${repository}/actions/workflows/${workflow.id}/runs?per_page=100`;
    let runs = getJsonArray(await getOrFail(reader, runsPath), "workflow_runs");
    if (runs.length > 0 && !isPastGracePeriod(runs[0], nowMs)) {
      result.result = "kept (last run less than 2 days ago)";
      continue;
    }
    // Deleting shifts the list, so the first page is read again until nothing deletable is left.
    while (budget > 0) {
      const deletable = runs.filter(isDeletableRun).slice(0, budget);
      if (deletable.length === 0) break;
      for (const run of deletable) {
        await runGithubCli(
          [
            "api",
            "--method",
            "DELETE",
            `repos/${repository}/actions/runs/${getJsonNumber(run, "id")}`,
          ],
          token
        );
        result.deleted += 1;
        budget -= 1;
      }
      runs = getJsonArray(await getOrFail(reader, runsPath), "workflow_runs");
    }
    const remaining = runs.length;
    result.result =
      remaining === 0
        ? "all runs deleted"
        : budget === 0
          ? "continues next run"
          : `${remaining} run(s) still in progress`;
  }

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Runs of removed workflows",
    "",
    results.length === 0
      ? "No removed workflow has runs left."
      : "| Workflow | File | Deleted runs | Result |\n|---|---|---|---|",
    ...results.map((item) => `| ${item.name} | ${item.path} | ${item.deleted} | ${item.result} |`),
  ]);
  console.log(
    `Deleted ${maxDeletionsPerRun - budget} run(s) of ${orphaned.length} removed workflow(s).`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
