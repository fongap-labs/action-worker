import { latestCiStatus, trustedControlRunId } from "./ci-evidence.ts";
import { getJsonArray, getJsonString, isJsonRecord, type GithubReader } from "./github-api.ts";
import { hasValidStatusAttestation, signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

const contexts = ["PR Governance", "validate-merge"] as const;

type StatusPublisher = typeof postGithubCommitStatus;

export async function reconcileMisattributedMainStatuses(
  reader: Pick<GithubReader, "get">,
  repository: string,
  mainSha: string,
  mergedPrHeadSha: string,
  mergedPrNumber: number,
  controlRepository: string,
  statusToken: string,
  runUrl: string,
  publish: StatusPublisher = postGithubCommitStatus
): Promise<string[]> {
  // This is only called after the main audit verifies the actual merged PR and its CI.
  // An original PR head is never eligible for main-commit status reconciliation.
  if (mainSha === mergedPrHeadSha) return [];
  const combined = await reader.get(`repos/${repository}/commits/${mainSha}/status`);
  const candidates = contexts
    .map((context) => ({ context, status: latestCiStatus(combined, context) }))
    .filter(
      ({ context, status }) =>
        getJsonString(status, "state") === "failure" &&
        hasValidStatusAttestation(status, { repository, sha: mainSha, context })
    );
  if (candidates.length === 0) return [];

  const [owner] = repository.split("/");
  const pulls = getJsonArray(
    await reader.get(
      `repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:main`)}&per_page=100`
    )
  ).filter(isJsonRecord);

  const repaired: string[] = [];
  const verifiedRuns = new Map<number, boolean>();
  for (const { context, status } of candidates) {
    const runId = trustedControlRunId(getJsonString(status, "target_url"), controlRepository);
    if (runId === null) continue;

    let verified = verifiedRuns.get(runId);
    if (verified === undefined) {
      const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
      const runStartedAt = Date.parse(getJsonString(run, "created_at"));
      const matchedReversePull = pulls.some((pull) => {
        const head = isJsonRecord(pull.head) ? pull.head : {};
        const base = isJsonRecord(pull.base) ? pull.base : {};
        const created = Date.parse(getJsonString(pull, "created_at"));
        const closed = Date.parse(getJsonString(pull, "closed_at"));
        return (
          getJsonString(pull, "state") === "closed" &&
          !getJsonString(pull, "merged_at") &&
          getJsonString(head, "ref") === "main" &&
          getJsonString(head, "sha") === mainSha &&
          getJsonString(base, "ref") !== "main" &&
          getJsonString(base, "ref") !== "" &&
          Number.isFinite(created) &&
          Number.isFinite(closed) &&
          Number.isFinite(runStartedAt) &&
          created <= runStartedAt &&
          runStartedAt <= closed
        );
      });
      verified =
        getJsonString(run, "path") === ".github/workflows/handle-pr-dispatch.yml" &&
        getJsonString(run, "event") === "repository_dispatch" &&
        getJsonString(run, "status") === "completed" &&
        getJsonString(run, "conclusion") === "failure" &&
        matchedReversePull;
      verifiedRuns.set(runId, verified);
    }
    if (!verified) continue;

    const state = "success";
    const description = signedStatusDescription({
      repository,
      sha: mainSha,
      state,
      context,
      description: `N/A on main: invalid reverse PR status; merged PR #${mergedPrNumber} verified`,
      targetUrl: runUrl,
    });
    await publish({
      repository,
      sha: mainSha,
      token: statusToken,
      state,
      context,
      description,
      targetUrl: runUrl,
    });
    repaired.push(context);
  }
  return repaired;
}
