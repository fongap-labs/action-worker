import {
  hasVerifiedCiEvidence,
  hasVerifiedControlStatus,
  latestCiStatus,
  trustedControlRunId,
} from "./ci-evidence.ts";
import {
  type GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { CliError } from "./runtime-command.ts";
import {
  hasValidStatusAttestation,
  latestAttestedStatus,
  originalStatusDescription,
  signedStatusDescription,
} from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

export type HistoricalMainReview = {
  repository: string;
  merge_sha: string;
  root_incident_sha: string;
  pr_number: number;
  approval_issue: number;
  /** Only the exact audited post-merge cancellation may use this immutable run receipt. */
  cancelled_governance_run_id?: number;
};

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const trustedApproval = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const gateContexts = ["PR Governance", "CI Evidence", "validate-merge"] as const;

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new CliError(`Historical main review denied: ${message}`, 65);
}

function asTimestamp(value: string): number {
  return value ? Date.parse(value) : Number.NaN;
}

export async function isAncestor(
  reader: Pick<GithubReader, "get">,
  repository: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const comparison = await reader.get(`repos/${repository}/compare/${ancestor}...${descendant}`);
  return (
    getJsonString(comparison, "status") === "ahead" &&
    getJsonString(isJsonRecord(comparison) ? comparison.merge_base_commit : null, "sha") ===
      ancestor
  );
}

export async function verifyMaintainerResolution(
  reader: Pick<GithubReader, "get">,
  item: HistoricalMainReview
): Promise<void> {
  const issue = await reader.get(`repos/${item.repository}/issues/${item.approval_issue}`);
  requireFact(
    getJsonString(issue, "state") === "closed" &&
      getJsonString(issue, "title") ===
        `Main write incident: ${item.root_incident_sha.slice(0, 12)}` &&
      getJsonString(issue, "body").includes(item.root_incident_sha),
    "incident must be closed and match the original rejected main write"
  );
  const comments = await reader.get(
    `repos/${item.repository}/issues/${item.approval_issue}/comments?per_page=100`
  );
  requireFact(
    Array.isArray(comments) &&
      comments.some(
        (comment) =>
          isJsonRecord(comment) &&
          getJsonString(comment, "body").trim() === "/resolve" &&
          trustedApproval.has(getJsonString(comment, "author_association").toUpperCase())
      ),
    "incident must have an explicit trusted maintainer /resolve"
  );
}

export async function verifyCompletedGovernance(
  reader: Pick<GithubReader, "get">,
  repository: string,
  headSha: string,
  status: unknown,
  validationStatus: unknown,
  mergedAt: number,
  controlRepository: string,
  allowedCancelledGovernanceRunId?: number
): Promise<void> {
  const runUrl = getJsonString(status, "target_url");
  requireFact(
    runUrl === getJsonString(validationStatus, "target_url"),
    "both governance gates must come from the same control run"
  );
  const runId = trustedControlRunId(runUrl, controlRepository);
  requireFact(runId !== null, "governance status must point to a trusted control run");
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
  requireFact(
    getJsonNumber(run, "id") === runId &&
      getJsonString(isJsonRecord(run) ? run.repository : null, "full_name") === controlRepository &&
      getJsonString(run, "path") === ".github/workflows/handle-pr-dispatch.yml" &&
      getJsonString(run, "head_branch") === "main" &&
      getJsonString(run, "event") === "repository_dispatch" &&
      getJsonString(run, "status") === "completed",
    "governance run identity, workflow and completion must match"
  );
  if (getJsonString(run, "conclusion") === "success") {
    for (const [context, signed] of [
      ["PR Governance", status],
      ["validate-merge", validationStatus],
    ] as const) {
      requireFact(
        await hasVerifiedControlStatus(reader, { statuses: [signed] }, context, {
          controlRepository,
          targetRepository: repository,
          targetSha: headSha,
          workflowPaths: [".github/workflows/handle-pr-dispatch.yml"],
          runAttempts: 1,
          retryDelayMs: 0,
        }),
        "successful governance run must verify the original signed status"
      );
    }
    return;
  }
  // A cancelled workflow cannot ordinarily attest a merged PR. The single, SHA-pinned
  // Delta incident below is different: its signed gates and real CI succeeded before
  // GitHub merged, and cancellation occurred only in post-gate review publication.
  // Never accept a pre-gate cancellation, an unrelated run, or a failed step.
  if (getJsonString(run, "conclusion") === "cancelled") {
    requireFact(
      allowedCancelledGovernanceRunId === runId &&
        Number.isFinite(mergedAt) &&
        asTimestamp(getJsonString(run, "run_started_at")) <= mergedAt,
      "cancelled governance must match an explicitly reviewed post-merge run"
    );
    const response = await reader.get(
      `repos/${controlRepository}/actions/runs/${runId}/jobs?per_page=100`
    );
    const jobs = getJsonArray(response, "jobs").filter(isJsonRecord);
    const governance = jobs.filter((job) => getJsonString(job, "name") === "PR Governance");
    const otherCancelled = jobs.filter(
      (job) =>
        getJsonString(job, "conclusion") === "cancelled" &&
        getJsonString(job, "name") !== "PR Governance"
    );
    requireFact(
      governance.length === 1 &&
        getJsonString(governance[0], "conclusion") === "cancelled" &&
        asTimestamp(getJsonString(governance[0], "completed_at")) >= mergedAt &&
        otherCancelled.length === 1 &&
        getJsonString(otherCancelled[0], "name") === "Automatic squash merge (operational)" &&
        jobs.every((job) => getJsonString(job, "conclusion") !== "failure"),
      "cancelled governance jobs must match the exact post-merge race"
    );
    const steps = getJsonArray(governance[0], "steps").filter(isJsonRecord);
    const cancelledSteps = steps.filter(
      (step) => getJsonString(step, "conclusion") === "cancelled"
    );
    requireFact(
      cancelledSteps.length === 1 &&
        getJsonString(cancelledSteps[0], "name") === "Publish PR review" &&
        asTimestamp(getJsonString(cancelledSteps[0], "completed_at")) >= mergedAt &&
        steps.every((step) => getJsonString(step, "conclusion") !== "failure") &&
        ["Update final gate", "Update central merge gate"].every((name) =>
          steps.some(
            (step) =>
              getJsonString(step, "name") === name &&
              getJsonString(step, "conclusion") === "success" &&
              asTimestamp(getJsonString(step, "completed_at")) <= mergedAt
          )
        ),
      "both signed gates must precede merge and only review publication may be cancelled later"
    );
    return;
  }
  // A failed governance workflow is never accepted merely because its status was green.
  // The sole permitted failure must be a post-approval, post-merge auto-merge race.
  requireFact(getJsonString(run, "conclusion") === "failure", "governance failed unexpectedly");
  const response = await reader.get(
    `repos/${controlRepository}/actions/runs/${runId}/jobs?per_page=100`
  );
  const jobs = getJsonArray(response, "jobs").filter(isJsonRecord);
  const failedJobs = jobs.filter((job) => getJsonString(job, "conclusion") === "failure");
  requireFact(failedJobs.length === 1, "only one auto-merge job may have failed");
  const failedJob = failedJobs[0];
  requireFact(
    getJsonString(failedJob, "name") === "PR Governance",
    "governance job identity mismatch"
  );
  const steps = getJsonArray(failedJob, "steps").filter(isJsonRecord);
  const failedSteps = steps.filter((step) => getJsonString(step, "conclusion") === "failure");
  const mergeStep = failedSteps[0];
  requireFact(
    failedSteps.length === 1 &&
      getJsonString(mergeStep, "name") === "Automatically merge CI-green PR" &&
      ["Update final gate", "Update central merge gate"].every((name) =>
        steps.some(
          (step) =>
            getJsonString(step, "name") === name && getJsonString(step, "conclusion") === "success"
        )
      ) &&
      asTimestamp(getJsonString(mergeStep, "completed_at")) >= mergedAt,
    "only a failed automatic merge after successful signed gates and GitHub merge may be reconciled"
  );
}

export async function reconcileHistoricalMainGuards(
  reader: Pick<GithubReader, "get">,
  repository: string,
  currentMainSha: string,
  controlRepository: string,
  statusToken: string,
  runUrl: string,
  cases: readonly HistoricalMainReview[],
  publish: typeof postGithubCommitStatus = postGithubCommitStatus
): Promise<string[]> {
  requireFact(
    repositoryPattern.test(repository) &&
      repositoryPattern.test(controlRepository) &&
      shaPattern.test(currentMainSha) &&
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(
        runUrl
      ),
    "invalid reconciliation identity"
  );
  const selected = cases.filter((item) => item.repository === repository);
  requireFact(selected.length <= 20, "historical review batch exceeds the bounded limit");
  const toPublish: Array<{ item: HistoricalMainReview; description: string }> = [];
  const seen = new Set<string>();
  for (const item of selected) {
    requireFact(
      shaPattern.test(item.merge_sha) &&
        shaPattern.test(item.root_incident_sha) &&
        Number.isSafeInteger(item.pr_number) &&
        item.pr_number > 0 &&
        Number.isSafeInteger(item.approval_issue) &&
        item.approval_issue > 0 &&
        !seen.has(item.merge_sha),
      "invalid or duplicate historical review case"
    );
    seen.add(item.merge_sha);
    if (item.cancelled_governance_run_id !== undefined) {
      requireFact(
        item.repository === "fongap-labs/delta" &&
          item.merge_sha === "b6e23bae43976e28b7c3f46c6b65041900a777be" &&
          item.root_incident_sha === item.merge_sha &&
          item.pr_number === 83 &&
          item.approval_issue === 87 &&
          item.cancelled_governance_run_id === 45116834848,
        "cancelled governance receipt is not the exact audited Delta incident"
      );
    }
    const currentStatus = await reader.get(`repos/${repository}/commits/${item.merge_sha}/status`);
    const guard = latestCiStatus(currentStatus, "Main Write Guard");
    if (
      getJsonString(guard, "state") === "success" &&
      hasValidStatusAttestation(guard, {
        repository,
        sha: item.merge_sha,
        context: "Main Write Guard",
      })
    ) {
      continue;
    }
    requireFact(
      getJsonString(guard, "state") === "failure" &&
        hasValidStatusAttestation(guard, {
          repository,
          sha: item.merge_sha,
          context: "Main Write Guard",
        }),
      "only a signed, failed historical Main Write Guard may be reassessed"
    );
    requireFact(
      (await isAncestor(reader, repository, item.root_incident_sha, item.merge_sha)) &&
        (await isAncestor(reader, repository, item.merge_sha, currentMainSha)),
      "incident, historical merge and current main must share the exact ancestry"
    );
    await verifyMaintainerResolution(reader, item);
    const pull = await reader.get(`repos/${repository}/pulls/${item.pr_number}`);
    const headSha = getJsonString(isJsonRecord(pull) ? pull.head : null, "sha");
    const mergeTime = asTimestamp(getJsonString(pull, "merged_at"));
    requireFact(
      getJsonNumber(pull, "number") === item.pr_number &&
        getJsonString(pull, "state") === "closed" &&
        isJsonRecord(pull) &&
        pull.merged === true &&
        getJsonString(pull, "merge_commit_sha") === item.merge_sha &&
        getJsonString(isJsonRecord(pull) ? pull.base : null, "ref") === "main" &&
        shaPattern.test(headSha) &&
        Number.isFinite(mergeTime),
      "the exact merged PR and original head must be attributable to this main SHA"
    );
    const headStatuses = await reader.get(`repos/${repository}/commits/${headSha}/status`);
    const gates = gateContexts.map((context) =>
      latestAttestedStatus(headStatuses, { repository, sha: headSha, context })
    );
    requireFact(
      gates.every(
        (gate) =>
          getJsonString(gate, "state") === "success" &&
          Number.isFinite(asTimestamp(getJsonString(gate, "created_at"))) &&
          asTimestamp(getJsonString(gate, "created_at")) <= mergeTime
      ),
      "all three signed CI gates must have succeeded before the original merge"
    );
    const title = getJsonString(pull, "title");
    const fingerprint = `title-sha256=${prTitleFingerprint(title)} `;
    requireFact(
      title.length > 0 &&
        [gates[0], gates[2]].every((gate) =>
          originalStatusDescription(gate).startsWith(fingerprint)
        ),
      "governance gates must bind to the actual merged PR title"
    );
    requireFact(
      await hasVerifiedCiEvidence(
        reader,
        { statuses: [gates[1]] },
        {
          controlRepository,
          targetRepository: repository,
          targetSha: headSha,
          runAttempts: 1,
          retryDelayMs: 0,
        }
      ),
      "original CI Evidence must have a successful trusted control run"
    );
    await verifyCompletedGovernance(
      reader,
      repository,
      headSha,
      gates[0],
      gates[2],
      mergeTime,
      controlRepository,
      item.cancelled_governance_run_id
    );
    toPublish.push({
      item,
      description: `Historical maintainer-reviewed main write via PR #${item.pr_number} (incident #${item.approval_issue})`,
    });
  }
  // Validate the entire batch before creating any new statuses.
  for (const { item, description } of toPublish) {
    await publish({
      repository,
      sha: item.merge_sha,
      token: statusToken,
      state: "success",
      context: "Main Write Guard",
      description: signedStatusDescription({
        repository,
        sha: item.merge_sha,
        state: "success",
        context: "Main Write Guard",
        description,
        targetUrl: runUrl,
      }),
      targetUrl: runUrl,
    });
  }
  return toPublish.map(({ item }) => item.merge_sha);
}
