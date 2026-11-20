import {
  hasVerifiedCiEvidence,
  isCiNotRunVerdict,
  latestCiStatus,
  postMergeRemediationStatusPrefix,
} from "./ci-evidence.ts";
import {
  type GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  type HistoricalMainReview,
  isAncestor,
  verifyCompletedGovernance,
  verifyMaintainerResolution,
} from "./historical-main-review.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { CliError } from "./runtime-command.ts";
import {
  hasValidStatusAttestation,
  latestAttestedStatus,
  originalStatusDescription,
  signedStatusDescription,
} from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

export type PostMergeMainRemediation = HistoricalMainReview & {
  ci_run_id: number;
  allowed_changed_files: string[];
};

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const maintainerAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function requireEvidence(value: unknown, reason: string): asserts value {
  if (!value) throw new CliError(`Post-merge CI remediation denied: ${reason}`, 65);
}

function timestamp(value: unknown): number {
  return Date.parse(getJsonString(value, "created_at"));
}

function documentFiles(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every(
      (file) =>
        isJsonRecord(file) &&
        getJsonString(file, "status") === "modified" &&
        expected.includes(getJsonString(file, "filename"))
    ) &&
    new Set(value.map((file) => getJsonString(file, "filename"))).size === expected.length
  );
}

/**
 * UI-only historical reconciliation: executed post-merge CI does NOT prove pre-merge CI.
 * The dedicated status must never be trusted for release or deployment provenance.
 */
export async function reconcilePostMergeMainRemediations(
  reader: Pick<GithubReader, "get">,
  repository: string,
  currentMainSha: string,
  controlRepository: string,
  statusToken: string,
  runUrl: string,
  cases: readonly PostMergeMainRemediation[],
  publish: typeof postGithubCommitStatus = postGithubCommitStatus
): Promise<string[]> {
  requireEvidence(
    repositoryPattern.test(repository) &&
      repositoryPattern.test(controlRepository) &&
      shaPattern.test(currentMainSha) &&
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(
        runUrl
      ),
    "invalid audit identity"
  );
  const selected = cases.filter((item) => item.repository === repository);
  requireEvidence(selected.length <= 5, "remediation exceeds the bounded case limit");
  const pending: Array<{ item: PostMergeMainRemediation; description: string }> = [];
  const seen = new Set<string>();

  for (const item of selected) {
    const expectedKeys = [
      "allowed_changed_files",
      "approval_issue",
      "ci_run_id",
      "merge_sha",
      "pr_number",
      "repository",
      "root_incident_sha",
    ];
    requireEvidence(
      isJsonRecord(item) &&
        Object.keys(item).sort().join(",") === expectedKeys.sort().join(",") &&
        shaPattern.test(item.merge_sha) &&
        item.root_incident_sha === item.merge_sha &&
        Number.isSafeInteger(item.pr_number) &&
        item.pr_number > 0 &&
        Number.isSafeInteger(item.approval_issue) &&
        item.approval_issue > 0 &&
        Number.isSafeInteger(item.ci_run_id) &&
        item.ci_run_id > 0 &&
        Array.isArray(item.allowed_changed_files) &&
        item.allowed_changed_files.length > 0 &&
        item.allowed_changed_files.length <= 10 &&
        item.allowed_changed_files.every(
          (file) =>
            typeof file === "string" && /^[A-Za-z0-9_./-]+\.md$/.test(file) && !file.includes("..")
        ) &&
        new Set(item.allowed_changed_files).size === item.allowed_changed_files.length &&
        !seen.has(item.merge_sha),
      "case must identify one unique document-only historical merge"
    );
    seen.add(item.merge_sha);

    const statuses = await reader.get(`repos/${repository}/commits/${item.merge_sha}/status`);
    const guard = latestCiStatus(statuses, "Main Write Guard");
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
    requireEvidence(
      getJsonString(guard, "state") === "failure" &&
        hasValidStatusAttestation(guard, {
          repository,
          sha: item.merge_sha,
          context: "Main Write Guard",
        }),
      "original main write failure must be signed and preserved"
    );
    requireEvidence(
      item.merge_sha !== currentMainSha &&
        (await isAncestor(reader, repository, item.merge_sha, currentMainSha)),
      "remediated commit must be strictly older than the current trusted main"
    );

    await verifyMaintainerResolution(reader, item);
    const comments = await reader.get(
      `repos/${repository}/issues/${item.approval_issue}/comments?per_page=100`
    );
    const acceptance = `/accept-post-merge-ci-remediation ${item.merge_sha}`;
    requireEvidence(
      Array.isArray(comments) &&
        comments.some(
          (comment) =>
            isJsonRecord(comment) &&
            getJsonString(comment, "body").trim() === acceptance &&
            maintainerAssociations.has(getJsonString(comment, "author_association").toUpperCase())
        ),
      "an explicit SHA-bound maintainer acceptance is required"
    );

    const pull = await reader.get(`repos/${repository}/pulls/${item.pr_number}`);
    const headSha = getJsonString(isJsonRecord(pull) ? pull.head : null, "sha");
    const mergeTime = Date.parse(getJsonString(pull, "merged_at"));
    requireEvidence(
      getJsonNumber(pull, "number") === item.pr_number &&
        getJsonString(pull, "state") === "closed" &&
        isJsonRecord(pull) &&
        pull.merged === true &&
        getJsonString(pull, "merge_commit_sha") === item.merge_sha &&
        getJsonString(isJsonRecord(pull) ? pull.base : null, "ref") === "main" &&
        shaPattern.test(headSha) &&
        Number.isFinite(mergeTime),
      "the original squash merge and PR head must match"
    );
    const headStatuses = await reader.get(`repos/${repository}/commits/${headSha}/status`);
    const governance = latestAttestedStatus(headStatuses, {
      repository,
      sha: headSha,
      context: "PR Governance",
    });
    const originalCi = latestAttestedStatus(headStatuses, {
      repository,
      sha: headSha,
      context: "CI Evidence",
    });
    const mergeGate = latestAttestedStatus(headStatuses, {
      repository,
      sha: headSha,
      context: "validate-merge",
    });
    requireEvidence(
      [governance, originalCi, mergeGate].every(
        (status) =>
          getJsonString(status, "state") === "success" &&
          Number.isFinite(timestamp(status)) &&
          timestamp(status) <= mergeTime
      ) &&
        isCiNotRunVerdict(originalStatusDescription(originalCi)) &&
        getJsonString(originalCi, "target_url") === getJsonString(governance, "target_url"),
      "pre-merge governance must be signed and the original CI skip must remain explicit"
    );
    const fingerprint = `title-sha256=${prTitleFingerprint(getJsonString(pull, "title"))} `;
    requireEvidence(
      getJsonString(pull, "title").length > 0 &&
        [governance, mergeGate].every((status) =>
          originalStatusDescription(status).startsWith(fingerprint)
        ),
      "original governance statuses must bind to the merged PR title"
    );
    await verifyCompletedGovernance(
      reader,
      repository,
      headSha,
      governance,
      mergeGate,
      mergeTime,
      controlRepository
    );

    const commit = await reader.get(`repos/${repository}/commits/${item.merge_sha}`);
    const pullFiles = await reader.get(
      `repos/${repository}/pulls/${item.pr_number}/files?per_page=100`
    );
    requireEvidence(
      getJsonString(commit, "sha") === item.merge_sha &&
        getJsonArray(commit, "parents").length === 1 &&
        getJsonNumber(pull, "changed_files") === item.allowed_changed_files.length &&
        documentFiles(getJsonArray(commit, "files"), item.allowed_changed_files) &&
        documentFiles(pullFiles, item.allowed_changed_files),
      "the immutable merge and original PR must modify only the explicitly approved documents"
    );

    const mergedCi = latestAttestedStatus(statuses, {
      repository,
      sha: item.merge_sha,
      context: "CI Evidence",
    });
    const targetCiUrl = `https://github.com/${controlRepository}/actions/runs/${item.ci_run_id}`;
    requireEvidence(
      getJsonString(mergedCi, "state") === "success" &&
        getJsonString(mergedCi, "target_url") === targetCiUrl &&
        originalStatusDescription(mergedCi).startsWith("Central CI passed") &&
        timestamp(mergedCi) > mergeTime,
      "a signed, successful post-merge CI status must target the exact squash commit"
    );
    const ciRun = await reader.get(`repos/${controlRepository}/actions/runs/${item.ci_run_id}`);
    requireEvidence(
      getJsonNumber(ciRun, "id") === item.ci_run_id &&
        getJsonString(ciRun, "path") === ".github/workflows/central-ci-dispatch.yml" &&
        getJsonString(ciRun, "event") === "repository_dispatch" &&
        getJsonString(ciRun, "status") === "completed" &&
        getJsonString(ciRun, "conclusion") === "success" &&
        Date.parse(getJsonString(ciRun, "run_started_at")) > mergeTime,
      "the exact central CI must have executed successfully after the original merge"
    );
    requireEvidence(
      await hasVerifiedCiEvidence(
        reader,
        { statuses: [mergedCi] },
        {
          controlRepository,
          targetRepository: repository,
          targetSha: item.merge_sha,
          runAttempts: 1,
          retryDelayMs: 0,
        }
      ),
      "the post-merge CI status must be signed and backed by its successful publisher run"
    );
    pending.push({
      item,
      description: `${postMergeRemediationStatusPrefix} PR #${item.pr_number} (incident #${item.approval_issue})`,
    });
  }
  // Validate the entire batch before publishing the first signed reconciliation.
  for (const { item, description } of pending) {
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
  return pending.map(({ item }) => item.merge_sha);
}
