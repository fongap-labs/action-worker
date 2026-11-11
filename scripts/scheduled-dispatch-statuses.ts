import { githubEnvironment, isJsonRecord } from "./github-api.ts";
import { CliError, runCommand } from "./runtime-command.ts";
import {
  hasValidStatusAttestation,
  originalStatusDescription,
  signedStatusDescription,
} from "./status-attestation.ts";

const pageSize = 100;
// Still bounded: never infer an unexamined recent page contains no receipt.
const maxPages = 50;
const clockSkewMarginMs = 5 * 60 * 1000;

export type ScheduledDispatchReceipt = {
  state: "pending" | "success";
  description: string;
};

export type ScheduledStatusTarget = {
  repository: string;
  head_sha: string;
  context: string;
};

/**
 * Keep status signatures, GitHub API payloads and action-run URLs identical
 * for scheduled task and deployment receipts.
 */
export function scheduledDispatchStatusPayload(
  target: ScheduledStatusTarget,
  state: ScheduledDispatchReceipt["state"],
  description: string
): string {
  const targetUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "";
  return JSON.stringify({
    state,
    context: target.context,
    description: signedStatusDescription({
      repository: target.repository,
      sha: target.head_sha,
      state,
      context: target.context,
      description,
      targetUrl,
    }),
    target_url: targetUrl || undefined,
  });
}

export async function writeScheduledDispatchStatus(
  target: ScheduledStatusTarget,
  token: string,
  state: ScheduledDispatchReceipt["state"],
  description: string
): Promise<void> {
  await runCommand(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${target.repository}/statuses/${target.head_sha}`,
      "--input",
      "-",
    ],
    {
      env: githubEnvironment(token),
      input: scheduledDispatchStatusPayload(target, state, description),
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    }
  );
}

/**
 * GitHub documents reverse-chronological status history. Once every record in
 * a complete page has a trustworthy, descending timestamp and the oldest is
 * older than the due slot (minus clock-skew margin), later pages cannot have
 * a valid receipt for that slot. Missing/unsorted timestamps never certify it.
 */
function historyPredatesSlot(statuses: unknown[], slot: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(slot)) return false;
  const cutoff = Date.parse(slot) - clockSkewMarginMs;
  if (!Number.isFinite(cutoff)) return false;
  let preceding = Number.POSITIVE_INFINITY;
  for (const item of statuses) {
    if (
      !isJsonRecord(item) ||
      typeof item.created_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item.created_at)
    ) {
      return false;
    }
    const created = Date.parse(item.created_at);
    if (!Number.isFinite(created) || created > preceding) return false;
    preceding = created;
  }
  return statuses.length > 0 && preceding < cutoff;
}

/** Persist a reservation before dispatch so an ambiguous API result cannot trigger a replay. */
export async function dispatchWithReservation(
  reserve: () => Promise<void>,
  dispatch: () => Promise<void>,
  confirm: () => Promise<void>
): Promise<void> {
  await reserve();
  await dispatch();
  await confirm();
}

/**
 * Look for an exact, signed dispatch receipt in commit status history.
 * GitHub's combined /status endpoint exposes only the latest status for a
 * context and cannot prove that a previous slot was never dispatched.
 */
export async function hasScheduledDispatchReceipt(
  repository: string,
  sha: string,
  context: string,
  receipts: readonly ScheduledDispatchReceipt[],
  get: (path: string) => Promise<unknown>,
  slot?: string
): Promise<boolean> {
  for (let page = 1; page <= maxPages; page += 1) {
    const path = `repos/${repository}/commits/${sha}/statuses?per_page=${pageSize}&page=${page}`;
    const statuses: unknown = await get(path);
    if (
      !Array.isArray(statuses) ||
      statuses.length > pageSize ||
      statuses.some((item) => !isJsonRecord(item))
    ) {
      throw new CliError(`GitHub scheduled dispatch status history is invalid: ${repository}.`, 65);
    }

    const isRecorded = statuses.some(
      (item) =>
        isJsonRecord(item) &&
        item.context === context &&
        receipts.some(
          (receipt) =>
            item.state === receipt.state && originalStatusDescription(item) === receipt.description
        ) &&
        hasValidStatusAttestation(item, { repository, sha, context })
    );
    if (isRecorded) return true;
    if (statuses.length < pageSize) return false;
    if (slot && historyPredatesSlot(statuses, slot)) return false;
  }

  throw new CliError(
    `Scheduled dispatch status history exceeds ${maxPages * pageSize} records on ${repository}@${sha}; refusing an unsafe replay.`,
    75
  );
}
