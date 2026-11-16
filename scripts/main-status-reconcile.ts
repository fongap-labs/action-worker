import { latestCiStatus, trustedControlRunId } from "./ci-evidence.ts";
import { type GithubReader, getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import { validateMainWriteProvenance } from "./main-write-guard.ts";
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
  )
    .filter(isJsonRecord)
    .filter((pull) => {
      const head = isJsonRecord(pull.head) ? pull.head : {};
      const base = isJsonRecord(pull.base) ? pull.base : {};
      return (
        getJsonString(pull, "state") === "closed" &&
        !getJsonString(pull, "merged_at") &&
        getJsonString(head, "ref") === "main" &&
        getJsonString(head, "sha") === mainSha &&
        getJsonString(base, "ref") !== "main" &&
        getJsonString(base, "ref") !== ""
      );
    });
  if (pulls.length === 0) return [];

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
        const created = Date.parse(getJsonString(pull, "created_at"));
        const closed = Date.parse(getJsonString(pull, "closed_at"));
        return (
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

export function previousMainCommitSha(history: unknown, currentSha: string): string | null {
  if (!Array.isArray(history) || history.length < 2) return null;
  const [current, previous] = history;
  if (!isJsonRecord(current) || !isJsonRecord(previous)) return null;
  const sha = getJsonString(previous, "sha");
  const parents = getJsonArray(current, "parents");
  if (
    getJsonString(current, "sha") !== currentSha ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    parents.length !== 1 ||
    getJsonString(parents[0], "sha") !== sha
  ) {
    return null;
  }
  return sha;
}

export async function reconcilePreviousMainStatuses(
  reader: GithubReader,
  repository: string,
  currentSha: string,
  centralCiRequired: boolean,
  controlRepository: string,
  statusToken: string,
  runUrl: string,
  publish: StatusPublisher = postGithubCommitStatus
): Promise<string[]> {
  // Bounded to the immediate parent of the verified main commit.
  const history = await reader.get(`repos/${repository}/commits?sha=${currentSha}&per_page=2`);
  const previousSha = previousMainCommitSha(history, currentSha);
  if (!previousSha) return [];

  const combined = await reader.get(`repos/${repository}/commits/${previousSha}/status`);
  const hasAttestedFailure = contexts.some((context) => {
    const status = latestCiStatus(combined, context);
    return (
      getJsonString(status, "state") === "failure" &&
      hasValidStatusAttestation(status, { repository, sha: previousSha, context })
    );
  });
  if (!hasAttestedFailure) return [];

  // A historical main SHA is not trusted by ancestry alone. Recheck the original
  // merged PR and its exact CI evidence before modifying any status.
  const provenance = await validateMainWriteProvenance(
    reader,
    repository,
    previousSha,
    centralCiRequired
  );
  return reconcileMisattributedMainStatuses(
    reader,
    repository,
    previousSha,
    provenance.pr_head_sha,
    provenance.pr_number,
    controlRepository,
    statusToken,
    runUrl,
    publish
  );
}
