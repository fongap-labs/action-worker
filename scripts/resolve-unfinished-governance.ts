import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const context = "PR Governance";
const description = "Action Worker PR governance did not complete for this head";

// The newest PR Governance status of a commit, read from its combined status.
export function latestGovernanceStatus(
  combined: unknown
): { state: string; target: string } | null {
  const statuses = getJsonArray(combined, "statuses")
    .filter((item) => isJsonRecord(item) && getJsonString(item, "context") === context)
    .sort((left, right) =>
      getJsonString(right, "created_at").localeCompare(getJsonString(left, "created_at"))
    );
  const latest = statuses[0];
  if (!isJsonRecord(latest)) {
    return null;
  }
  return { state: getJsonString(latest, "state"), target: getJsonString(latest, "target_url") };
}

// The run a status points at, when it points at a run of the control repository.
export function targetRunId(target: string, controlRepository: string): number | null {
  const match = new RegExp(
    `^https://github\\.com/${controlRepository.replace(/[.]/g, "\\.")}/actions/runs/([0-9]+)$`
  ).exec(target);
  return match ? Number(match[1]) : null;
}

// A pending status is unfinished when its owner can no longer finish it: the run that owns it is
// this run (which has already ended without marking the head), or the run it names has completed.
// A pending status of a run still in progress belongs to that run and is left alone.
export function isUnfinished(
  status: { state: string; target: string } | null,
  ownRunUrl: string,
  isTargetRunCompleted: boolean
): boolean {
  if (status === null || status.state !== "pending") {
    return false;
  }
  return status.target === ownRunUrl || isTargetRunCompleted;
}

async function main(): Promise<void> {
  const [repository = "", prNumber = "", ownRunUrl = ""] = process.argv.slice(2);
  const controlRepository = process.env.CONTROL_REPOSITORY ?? "";
  const token = process.env.GH_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9]+$/.test(prNumber)) {
    throw new CliError("::error::Invalid repository or pull request number.", 64);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository) || !ownRunUrl) {
    throw new CliError("::error::Control repository and run URL are required.", 64);
  }
  if (!token) {
    throw new CliError("::error::GH_TOKEN is required.");
  }

  const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
  const head = isJsonRecord(pull) && isJsonRecord(pull.head) ? getJsonString(pull.head, "sha") : "";
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new CliError(`::error::Pull request ${repository}#${prNumber} has no head commit.`, 65);
  }
  const combined = await getGithubJson(`repos/${repository}/commits/${head}/status`, token);
  const status = latestGovernanceStatus(combined);

  const runId = status ? targetRunId(status.target, controlRepository) : null;
  const isTargetRunCompleted =
    runId === null
      ? false
      : getJsonString(
          await getGithubJson(`repos/${controlRepository}/actions/runs/${runId}`, token),
          "status"
        ) === "completed";
  if (!isUnfinished(status, ownRunUrl, isTargetRunCompleted)) {
    console.log(`PR governance for ${repository}@${head} is not left unfinished.`);
    return;
  }

  await runGithubCli(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/statuses/${head}`,
      "-f",
      "state=failure",
      "-f",
      `context=${context}`,
      "-f",
      `description=${description}`,
      "-f",
      `target_url=${ownRunUrl}`,
    ],
    token
  );
  console.log(`Resolved unfinished PR governance for ${repository}@${head} as failure.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
