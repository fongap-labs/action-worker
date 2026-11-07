import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";
import { hasValidStatusAttestation, originalStatusDescription } from "./status-attestation.ts";

const pageSize = 100;
const maxPages = 10;

export type ScheduledDispatchReceipt = {
  state: "pending" | "success";
  description: string;
};

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
  get: (path: string) => Promise<unknown>
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
  }

  throw new CliError(
    `Scheduled dispatch status history exceeds ${maxPages * pageSize} records on ${repository}@${sha}; refusing an unsafe replay.`,
    75
  );
}
