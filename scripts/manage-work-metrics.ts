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

export function metricIncrementForWorkflow(
  workflow: string,
  hasReview = false,
): Record<string, number> {
  if (workflow === "Handle Task Dispatch") {
    return { dispatch: 1, pr_governance: 0, ai_review: 0, release_governance: 0 };
  }
  if (workflow === "Handle PR Dispatch") {
    return { dispatch: 0, pr_governance: 1, ai_review: hasReview ? 1 : 0, release_governance: 0 };
  }
  if (workflow === "Handle Release Dispatch") {
    return { dispatch: 0, pr_governance: 0, ai_review: 0, release_governance: 1 };
  }
  throw new CliError(`::error::Unsupported workflow_run source: ${workflow}`, 65);
}

async function prepareIncrement(): Promise<void> {
  const eventName = process.env.EVENT_NAME ?? "";
  if (eventName !== "workflow_run") {
    await appendLines(process.env.GITHUB_OUTPUT, ["json="]);
    return;
  }
  const workflow = process.env.SOURCE_WORKFLOW ?? "";
  let hasReview = false;
  if (workflow === "Handle PR Dispatch") {
    const token = requireEnv("GH_TOKEN");
    const repository = requireEnv("GITHUB_REPOSITORY");
    const runId = requireEnv("SOURCE_RUN_ID");
    const text = await runGithubCli(["api", `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`], token);
    const response = JSON.parse(text) as unknown;
    hasReview = getJsonArray(response, "jobs").some((job) => {
      const steps = isJsonRecord(job) && Array.isArray(job.steps) ? job.steps : [];
      return steps.some((step) => isJsonRecord(step)
        && getJsonString(step, "name") === "Run AI review"
        && getJsonString(step, "conclusion") === "success");
    });
  }
  const increment = metricIncrementForWorkflow(workflow, hasReview);
  await appendLines(process.env.GITHUB_OUTPUT, [`json=${JSON.stringify(increment)}`]);
}

async function detectChanges(): Promise<void> {
  const status = await runText("git", ["status", "--porcelain", "--", "README.md", "README.zh-CN.md"]);
  await appendLines(process.env.GITHUB_OUTPUT, [`changed=${status ? "true" : "false"}`]);
}

async function createBranch(): Promise<void> {
  const branch = requireEnv("BRANCH");
  await runCommand("git", ["config", "user.name", "github-actions[bot]"]);
  await runCommand("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  await runCommand("git", ["checkout", "-b", branch]);
  await runCommand("git", ["add", "README.md", "README.zh-CN.md"]);
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
    "Verified work metrics.", "",
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

async function cleanupMetricsUpdate(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const branch = requireEnv("BRANCH");
  const prNumber = process.env.PR_NUMBER ?? "";

  if (prNumber) {
    try {
      await runGithubCli([
        "api", "--method", "PATCH", `repos/${repository}/pulls/${prNumber}`, "-f", "state=closed",
      ], token);
    } catch (error) {
      console.error(`::warning::Failed to close metrics pull request: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await runGithubCli(["api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`], token);
  } catch (error) {
    console.error(`::warning::Failed to clean metrics branch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runMetricsCi(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const branch = requireEnv("BRANCH");
  const headSha = requireEnv("HEAD_SHA");
  let runId = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const text = await runGithubCli([
      "run", "list", "--workflow", "validate-ci.yml", "--branch", branch,
      "--event", "pull_request", "--limit", "10", "--json", "databaseId,headSha",
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
    throw new CliError("::error::No pull-request CI run was found for the metrics branch.");
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

async function sweepMetricsBranches(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const currentBranch = process.env.BRANCH ?? "";

  const refsRaw = await runGithubCli([
    "api", `repos/${repository}/git/matching-refs/heads/metrics/`,
    "--paginate",
  ], token);
  const refs = JSON.parse(refsRaw) as Array<{ ref?: string }>;

  const openPullsRaw = await runGithubCli([
    "api", "--method", "GET", `repos/${repository}/pulls`,
    "-f", "state=open",
    "-f", "per_page=100",
    "--paginate",
  ], token);
  const openPulls = JSON.parse(openPullsRaw) as Array<{ head?: { ref?: string } }>;
  const openBranches = new Set(
    openPulls.map((pull) => pull.head?.ref ?? "").filter(Boolean),
  );

  let deleted = 0;
  for (const entry of refs) {
    const fullRef = entry.ref ?? "";
    const branch = fullRef.replace(/^refs\/heads\//, "");
    if (!branch.startsWith("metrics/") || branch === currentBranch || openBranches.has(branch)) continue;
    await runGithubCli([
      "api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`,
    ], token);
    deleted += 1;
  }

  console.log(`Stale metrics branches deleted: ${deleted}`);
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "increment": await prepareIncrement(); break;
    case "changes": await detectChanges(); break;
    case "branch": await createBranch(); break;
    case "pull": await createPull(); break;
    case "cleanup": await cleanupMetricsUpdate(); break;
    case "sweep": await sweepMetricsBranches(); break;
    case "ci": await runMetricsCi(); break;
    case "merge": await mergePull(); break;
    default: throw new CliError("Usage: manage-work-metrics.ts <increment|changes|branch|pull|cleanup|sweep|ci|merge>", 64);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
