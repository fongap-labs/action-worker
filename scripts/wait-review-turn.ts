import {
  getGithubJson,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError("Usage: wait-review-turn.ts <repository> <workflow-file> <run-id> <policy-file>", 64);
  }
  const [repository = "", workflow = "", runId = "", policyPath = ""] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError(`ERROR: invalid repository: ${repository}`, 65);
  }
  if (!/^[0-9]+$/.test(runId)) {
    throw new CliError("ERROR: invalid run id.", 65);
  }
  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("ERROR: GH_TOKEN is required.");
  }
  const policy = await readJson(policyPath);
  const runtime = isJsonRecord(policy) && isJsonRecord(policy.runtime) ? policy.runtime : {};
  const pollSeconds = getJsonNumber(runtime, "queue_poll_seconds") || 15;
  const waitMinutes = getJsonNumber(runtime, "queue_wait_minutes") || 120;
  if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 300) {
    throw new CliError("ERROR: queue_poll_seconds must be 5-300.", 65);
  }
  if (!Number.isInteger(waitMinutes) || waitMinutes < 1 || waitMinutes > 360) {
    throw new CliError("ERROR: queue_wait_minutes must be 1-360.", 65);
  }
  const deadline = Date.now() + waitMinutes * 60_000;
  let lastOwner = "";
  while (Date.now() < deadline) {
    const response = await getGithubJson(`repos/${repository}/actions/workflows/${workflow}/runs?per_page=100`, token);
    const active = getJsonArray(response, "workflow_runs")
      .filter((item) => isJsonRecord(item) && ["queued", "in_progress"].includes(getJsonString(item, "status")))
      .sort((left, right) => {
        const leftDate = isJsonRecord(left) ? getJsonString(left, "run_started_at") || getJsonString(left, "created_at") : "";
        const rightDate = isJsonRecord(right) ? getJsonString(right, "run_started_at") || getJsonString(right, "created_at") : "";
        const dateOrder = leftDate.localeCompare(rightDate);
        return dateOrder || (isJsonRecord(left) ? getJsonNumber(left, "id") : 0) - (isJsonRecord(right) ? getJsonNumber(right, "id") : 0);
      });
    if (active.length === 0) {
      console.log(`AI Review queue is empty: run=${runId} acquired`);
      return;
    }
    const owner = String(getJsonNumber(active[0], "id"));
    if (!owner || owner === runId) {
      console.log(`AI Review queue turn acquired: run=${runId}`);
      return;
    }
    if (owner !== lastOwner) {
      console.error(`AI Review queue waiting: run=${runId} owner=${owner}`);
      lastOwner = owner;
    }
    await sleep(pollSeconds * 1000);
  }
  throw new CliError(`ERROR: AI Review queue wait exceeded ${waitMinutes} minute(s).`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
