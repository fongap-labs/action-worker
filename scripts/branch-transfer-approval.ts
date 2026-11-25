import {
  type PrCiScope,
  prCiScopeDescription,
  readCurrentTransferScope,
} from "./ci-scope-receipt.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Reader = { get(path: string): Promise<unknown> };

const environmentName = "branch-transfer";
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

// A rerun or a change in any snapshot field requires a different approval comment.
export function transferApprovalComment(scope: PrCiScope, runId: number, attempt: number): string {
  if (!isPositiveInteger(runId) || !isPositiveInteger(attempt)) {
    throw new CliError("Invalid branch transfer run identity.", 65);
  }
  return `approve-transfer ${runId}/${attempt} ${prCiScopeDescription(scope)}`;
}

function approvedReviewerIds(environment: unknown): Set<number> {
  if (
    !isJsonRecord(environment) ||
    getJsonString(environment, "name") !== environmentName ||
    !isPositiveInteger(getJsonNumber(environment, "id")) ||
    !Array.isArray(environment.protection_rules)
  ) {
    return new Set();
  }
  const rules = environment.protection_rules.filter(
    (rule) => isJsonRecord(rule) && rule.type === "required_reviewers"
  );
  if (rules.length !== 1 || !isJsonRecord(rules[0]) || !Array.isArray(rules[0].reviewers)) {
    return new Set();
  }
  const reviewers = rules[0].reviewers;
  const ids = new Set<number>();
  for (const item of reviewers) {
    if (!isJsonRecord(item) || item.type !== "User") return new Set();
    const id = getJsonNumber(item.reviewer, "id");
    if (!isPositiveInteger(id)) return new Set();
    ids.add(id);
  }
  return ids;
}

export async function assertExactBranchApproval(
  reader: Reader,
  controlRepository: string,
  runId: number,
  attempt: number,
  comment: string,
  workflow:
    | ".github/workflows/handle-pr-dispatch.yml"
    | ".github/workflows/authorize-branch-transfer.yml"
): Promise<void> {
  if (!repositoryPattern.test(controlRepository)) {
    throw new CliError("Invalid trusted control repository.", 65);
  }
  const prefix = `repos/${controlRepository}`;
  const run = await reader.get(`${prefix}/actions/runs/${runId}`);
  if (
    !isJsonRecord(run) ||
    getJsonNumber(run, "id") !== runId ||
    getJsonNumber(run, "run_attempt") !== attempt ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    getJsonString(run, "head_branch") !== "main" ||
    getJsonString(run, "path") !== workflow ||
    getJsonString(run, "status") !== "in_progress"
  ) {
    throw new CliError("Branch transfer approval requires the current trusted governance run.", 75);
  }
  const environment = await reader.get(`${prefix}/environments/${environmentName}`);
  const reviewerIds = approvedReviewerIds(environment);
  if (reviewerIds.size === 0) {
    throw new CliError("Branch transfer environment has no explicit user reviewers.", 77);
  }
  const environmentId = getJsonNumber(environment, "id");
  const approvals = await reader.get(`${prefix}/actions/runs/${runId}/approvals`);
  if (!Array.isArray(approvals)) {
    throw new CliError("Branch transfer review history is unavailable.", 77);
  }
  let isApproved = false;
  for (const review of approvals) {
    if (!isJsonRecord(review) || !Array.isArray(review.environments)) continue;
    const matchesEnvironment = review.environments.some(
      (item) =>
        getJsonNumber(item, "id") === environmentId &&
        getJsonString(item, "name") === environmentName
    );
    if (!matchesEnvironment) continue;
    if (review.state === "rejected") {
      throw new CliError("Branch transfer environment review was rejected.", 77);
    }
    if (
      review.state === "approved" &&
      getJsonString(review.user, "type") === "User" &&
      reviewerIds.has(getJsonNumber(review.user, "id")) &&
      getJsonString(review, "comment") === comment
    ) {
      isApproved = true;
    }
  }
  if (!isApproved) {
    throw new CliError("Exact maintainer branch transfer approval is missing.", 77);
  }
}

export async function assertBranchTransferApproval(
  reader: Reader,
  controlRepository: string,
  scope: PrCiScope,
  runId: number,
  attempt: number,
  workflow:
    | ".github/workflows/handle-pr-dispatch.yml"
    | ".github/workflows/authorize-branch-transfer.yml" = ".github/workflows/handle-pr-dispatch.yml"
): Promise<void> {
  await assertExactBranchApproval(
    reader,
    controlRepository,
    runId,
    attempt,
    transferApprovalComment(scope, runId, attempt),
    workflow
  );
  const current = await readCurrentTransferScope(
    reader,
    scope.repository,
    scope.prNumber,
    scope.headSha
  );
  if (!current || prCiScopeDescription(current) !== prCiScopeDescription(scope)) {
    throw new CliError("Branch transfer scope changed after approval.", 75);
  }
}
