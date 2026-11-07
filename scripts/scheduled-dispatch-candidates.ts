import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const pageSize = 100;
// A bounded scan fails closed rather than risk rerunning a side-effecting task/deploy.
const maxPages = 10;

function commitShas(value: unknown, repository: string): string[] {
  if (!Array.isArray(value) || value.length > pageSize) {
    throw new CliError(`GitHub scheduled dispatch commit list is invalid: ${repository}.`, 65);
  }
  return value.map((item) => {
    const sha = isJsonRecord(item) && typeof item.sha === "string" ? item.sha : "";
    if (!shaPattern.test(sha)) {
      throw new CliError(`GitHub scheduled dispatch commit list is invalid: ${repository}.`, 65);
    }
    return sha;
  });
}

/**
 * Find every candidate default-branch head that could have recorded a slot's
 * dispatch status, even if a busy repository has more than 100 commits in the
 * scheduler lookback. Never assume an unexamined page contains no receipt.
 */
export async function scheduledDispatchCandidateShas(
  repository: string,
  headSha: string,
  slot: string,
  get: (path: string) => Promise<unknown>
): Promise<Set<string>> {
  const slotTime = `${slot.slice(0, 16)}:00Z`;
  const base = `repos/${repository}/commits?sha=${headSha}`;
  const candidates = new Set<string>([headSha]);

  for (let page = 1; page <= maxPages; page += 1) {
    const path = `${base}&since=${slotTime}&per_page=${pageSize}${
      page === 1 ? "" : `&page=${page}`
    }`;
    const shas = commitShas(await get(path), repository);
    for (const sha of shas) candidates.add(sha);
    if (shas.length < pageSize) break;
    if (page === maxPages) {
      throw new CliError(
        `Scheduled dispatch history exceeds ${maxPages * pageSize} commits for ${repository}; refusing an unsafe replay.`,
        75
      );
    }
  }

  // Include the last head preceding the slot; it may contain the receipt when
  // a scheduled run started just after a commit boundary.
  for (const sha of commitShas(
    await get(`${base}&until=${slotTime}&per_page=1`),
    repository
  )) {
    candidates.add(sha);
  }
  return candidates;
}
