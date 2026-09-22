import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { access, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
  runCommand,
  runText,
} from "./runtime-command.ts";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requireEnv(name: string): string {
  const value = process.env[name] ?? "";
  if (!value) {
    throw new CliError(`::error::${name} is required.`);
  }
  return value;
}

const metricsPolicyPath = join(dirname(fileURLToPath(import.meta.url)), "..", "policies", "work-metrics.json");
const metricsPolicy = JSON.parse(await readFile(metricsPolicyPath, "utf8"));

async function prepareIncrement(): Promise<void> {
  const eventName = process.env.EVENT_NAME ?? "";
  if (eventName !== "workflow_run") {
    await appendLines(process.env.GITHUB_OUTPUT, ["json="]);
    return;
  }
  const workflow = process.env.SOURCE_WORKFLOW ?? "";
  const policy = metricsPolicy.workflow_metrics[workflow];
  if (!policy) {
    throw new CliError(`::error::Unsupported workflow_run source: ${workflow}`, 65);
  }
  let increment = { ...policy };
  if (workflow === "Handle PR Dispatch") {
    const token = requireEnv("GH_TOKEN");
    const repository = requireEnv("GITHUB_REPOSITORY");
    const runId = requireEnv("SOURCE_RUN_ID");
    const text = await runGithubCli(["api", `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`], token);
    const response = JSON.parse(text) as unknown;
    const hasReview = getJsonArray(response, "jobs").some((job) => {
      const steps = isJsonRecord(job) && Array.isArray(job.steps) ? job.steps : [];
      return steps.some((step) => isJsonRecord(step)
        && getJsonString(step, "name") === "Run AI review"
        && getJsonString(step, "conclusion") === "success");
    });
    increment.ai_review = hasReview ? 1 : 0;
  }
  await appendLines(process.env.GITHUB_OUTPUT, [`json=${JSON.stringify(increment)}`]);
}

async function detectChanges(): Promise<void> {
  const status = await runText("git", ["status", "--porcelain", "--", "README.md"]);
  await appendLines(process.env.GITHUB_OUTPUT, [`changed=${status ? "true" : "false"}`]);
}

async function createBranch(): Promise<void> {
  const branch = requireEnv("BRANCH");
  await runCommand("git", ["config", "user.name", "github-actions[bot]"]);
  await runCommand("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  await runCommand("git", ["checkout", "-b", branch]);
  await runCommand("git", ["add", "README.md"]);
  await runCommand("git", ["commit", "-m", "chore: update work metrics"]);
  await runCommand("git", ["fetch", "origin", "main"]);
  await runCommand("git", ["rebase", "origin/main"]);
  await runCommand("git", ["push", "origin", branch]);
  const sha = await runText("git", ["rev-parse", "HEAD"]);
  await appendLines(process.env.GITHUB_OUTPUT, [`name=${branch}`, `sha=${sha}`]);
}

async function createPull(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const branch = requireEnv("BRANCH");
  const body = [
    "Daily verified work metrics.", "",
    `- Dispatch: ${process.env.DISPATCH ?? "0"}`,
    `- PR Governance: ${process.env.PR_GOVERNANCE ?? "0"}`,
    `- AI Review: ${process.env.AI_REVIEW ?? "0"}`,
    `- Gate: ${process.env.GATE ?? "0"}`,
    `- Release Governance: ${process.env.RELEASE_GOVERNANCE ?? "0"}`,
  ].join("\n");
  const text = await runGithubCli([
    "api", "--method", "POST", `repos/${repository}/pulls`,
    "-f", "base=main", "-f", `head=${branch}`,
    "-f", "title=chore: update work metrics", "-f", `body=${body}`,
  ], token);
  const pull = JSON.parse(text) as unknown;
  if (!isJsonRecord(pull) || !getJsonString(pull, "html_url") || !getJsonNumber(pull, "number")) {
    throw new CliError("::error::GitHub returned an invalid metrics pull request.");
  }
  await appendLines(process.env.GITHUB_OUTPUT, [
    `url=${getJsonString(pull, "html_url")}`,
    `number=${getJsonNumber(pull, "number")}`,
  ]);
}

async function cleanupBranch(): Promise<void> {
  try {
    await runCommand("git", ["push", "origin", "--delete", requireEnv("BRANCH")]);
  } catch (error) {
    console.error(`::warning::Failed to clean metrics branch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runMetricsCi(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const branch = requireEnv("BRANCH");
  const headSha = requireEnv("HEAD_SHA");
  await runGithubCli(["workflow", "run", "validate-ci.yml", "--ref", branch], token);
  let runId = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = await runGithubCli([
      "run", "list", "--workflow", "validate-ci.yml", "--branch", branch,
      "--event", "workflow_dispatch", "--limit", "10", "--json", "databaseId,headSha",
    ], token);
    const runs = JSON.parse(text) as unknown;
    const matched = Array.isArray(runs) ? runs.find((run) => isJsonRecord(run) && getJsonString(run, "headSha") === headSha) : undefined;
    runId = isJsonRecord(matched) ? getJsonNumber(matched, "databaseId") : 0;
    if (runId) {
      break;
    }
    await sleep(2000);
  }
  if (!runId) {
    throw new CliError("::error::No CI run was found for the metrics branch.");
  }
  await runGithubCli(["run", "watch", String(runId), "--exit-status"], token);
  await appendLines(process.env.GITHUB_OUTPUT, [`run_id=${runId}`]);
}

async function mergePull(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const prNumber = requireEnv("PR_NUMBER");
  const branch = requireEnv("BRANCH");
  const text = await runGithubCli([
    "api", "--method", "PUT", `repos/${repository}/pulls/${prNumber}/merge`, "-f", "merge_method=squash",
  ], token);
  const result = JSON.parse(text) as unknown;
  if (!isJsonRecord(result) || result.merged !== true) {
    throw new CliError("::error::Metrics pull request was not merged.");
  }
  await runGithubCli(["api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`], token);
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "increment": await prepareIncrement(); break;
    case "changes": await detectChanges(); break;
    case "branch": await createBranch(); break;
    case "pull": await createPull(); break;
    case "cleanup": await cleanupBranch(); break;
    case "ci": await runMetricsCi(); break;
    case "merge": await mergePull(); break;
    default: throw new CliError("Usage: manage-work-metrics.ts <increment|changes|branch|pull|cleanup|ci|merge>", 64);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
