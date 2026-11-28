import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  decodeGithubContent,
  getGithubJsonIfExists,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowPath = ".github/workflows/private-source-ci.yml";
const prefix = "Private source verification / ";

export type PrivateCiIdentity = {
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  headBranch: string;
  targetBranch?: "main" | "dev";
  linuxShards: readonly string[];
  hasWindows: boolean;
};

export type VerifiedPrivateCi = { runId: number; runAttempt: number };

function fail(): never {
  throw new CliError("Private source CI evidence is absent, stale or incomplete.", 65);
}

function assertIdentity(identity: PrivateCiIdentity): void {
  if (
    (identity.targetBranch !== undefined &&
      identity.targetBranch !== "main" &&
      identity.targetBranch !== "dev") ||
    !repositoryPattern.test(identity.repository) ||
    !Number.isSafeInteger(identity.prNumber) ||
    identity.prNumber < 1 ||
    !shaPattern.test(identity.baseSha) ||
    !shaPattern.test(identity.headSha) ||
    !/^[A-Za-z0-9._/-]{1,200}$/.test(identity.headBranch) ||
    identity.linuxShards.length < 1 ||
    identity.linuxShards.length > 8 ||
    new Set(identity.linuxShards).size !== identity.linuxShards.length ||
    identity.linuxShards.some((shard) => !/^[a-z][a-z0-9-]{0,31}$/.test(shard))
  ) {
    fail();
  }
}

function expectedRunTitle(identity: PrivateCiIdentity): string {
  const lane = identity.targetBranch === "dev" ? "private-ci-dev" : "private-ci";
  return `${lane}-${identity.prNumber}-${identity.baseSha}-${identity.headSha}`;
}

function matchingRun(value: unknown, identity: PrivateCiIdentity): boolean {
  if (!isJsonRecord(value)) return false;
  const repo = value.repository;
  const repoId = getJsonNumber(repo, "id");
  return (
    isJsonRecord(repo) &&
    getJsonString(repo, "full_name") === identity.repository &&
    repoId > 0 &&
    getJsonString(value, "name") === expectedRunTitle(identity) &&
    getJsonNumber(value, "workflow_id") > 0 &&
    getJsonString(value, "path") === workflowPath &&
    getJsonString(value, "event") === "pull_request_target" &&
    getJsonString(value, "head_sha") === identity.headSha &&
    getJsonString(value, "head_branch") === identity.headBranch &&
    getJsonNumber(value, "id") > 0 &&
    Number.isSafeInteger(getJsonNumber(value, "id")) &&
    getJsonString(value, "display_title") === expectedRunTitle(identity)
  );
}

function expectedJobNames(identity: PrivateCiIdentity): Set<string> {
  return new Set([
    `${prefix}Verify caller and trusted CI plan`,
    `${prefix}Private security and dependency integrity`,
    ...identity.linuxShards.map((shard) => `${prefix}Private Linux (${shard})`),
    `${prefix}Private Windows`,
  ]);
}

export function verifyPrivateCiEvidence(
  identity: PrivateCiIdentity,
  runsResponse: unknown,
  jobsResponse: unknown
): VerifiedPrivateCi {
  assertIdentity(identity);
  if (!isJsonRecord(runsResponse)) fail();
  const runs = getJsonArray(runsResponse, "workflow_runs");
  if (
    typeof runsResponse.total_count !== "number" ||
    !Number.isSafeInteger(runsResponse.total_count) ||
    runsResponse.total_count < 0 ||
    runsResponse.total_count > runs.length
  ) {
    fail();
  }
  const matches = runs.filter((run) => matchingRun(run, identity));
  if (matches.length === 0) fail();
  const run = matches.sort((a, b) => getJsonNumber(b, "id") - getJsonNumber(a, "id"))[0];
  if (
    !isJsonRecord(run) ||
    getJsonString(run, "status") !== "completed" ||
    getJsonString(run, "conclusion") !== "success"
  ) {
    fail();
  }
  const runId = getJsonNumber(run, "id");
  const runAttempt = getJsonNumber(run, "run_attempt");
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) fail();

  if (!isJsonRecord(jobsResponse)) fail();
  const jobs = getJsonArray(jobsResponse, "jobs");
  if (
    typeof jobsResponse.total_count !== "number" ||
    !Number.isSafeInteger(jobsResponse.total_count) ||
    jobsResponse.total_count < 0 ||
    jobsResponse.total_count !== jobs.length
  ) {
    fail();
  }
  const expected = expectedJobNames(identity);
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!isJsonRecord(job)) fail();
    const name = getJsonString(job, "name");
    if (
      !expected.has(name) ||
      seen.has(name) ||
      getJsonNumber(job, "run_id") !== runId ||
      getJsonString(job, "status") !== "completed"
    ) {
      fail();
    }
    const conclusion = getJsonString(job, "conclusion");
    if (name === `${prefix}Private Windows` && !identity.hasWindows) {
      if (conclusion !== "skipped") fail();
    } else if (conclusion !== "success") {
      fail();
    }
    seen.add(name);
  }
  if (seen.size !== expected.size) fail();
  return { runId, runAttempt };
}

export async function hasApprovedPrivateCiCaller(
  reader: { get(path: string): Promise<unknown> },
  repository: string,
  baseSha: string
): Promise<boolean> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(baseSha)) return false;
  // A run title is trusted only when its caller is the audited workflow on the exact PR base.
  const [caller, policyText] = await Promise.all([
    getGithubJsonIfExists(`repos/${repository}/contents/${workflowPath}?ref=${baseSha}`, (path) => reader.get(path)),
    readFile("policies/security.json", "utf8"),
  ]);
  const policy: unknown = JSON.parse(policyText);
  if (!isJsonRecord(caller) || !isJsonRecord(policy)) return false;
  if (getJsonString(caller, "path") !== workflowPath || getJsonString(caller, "type") !== "file") {
    return false;
  }
  const matches = getJsonArray(policy, "approved_workflows").filter(
    (item) => isJsonRecord(item) && getJsonString(item, "path") === workflowPath
  );
  if (matches.length !== 1) return false;
  const trustedHash = getJsonString(matches[0], "sha256");
  if (!/^[0-9a-f]{64}$/.test(trustedHash)) return false;
  const content = decodeGithubContent(caller);
  const actualHash = createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
  return actualHash === trustedHash;

}

export async function fetchAndVerifyPrivateCiEvidence(
  reader: { get(path: string): Promise<unknown> },
  identity: PrivateCiIdentity
): Promise<VerifiedPrivateCi> {
  assertIdentity(identity);
  const repo = identity.repository;
  if (!(await hasApprovedPrivateCiCaller(reader, repo, identity.baseSha))) fail();

  const runs = await reader.get(
    `repos/${repo}/actions/workflows/private-source-ci.yml/runs?event=pull_request_target&head_sha=${identity.headSha}&per_page=100`
  );
  if (!isJsonRecord(runs)) fail();
  const items = getJsonArray(runs, "workflow_runs");
  const matching = items
    .filter((run) => matchingRun(run, identity))
    .sort((a, b) => getJsonNumber(b, "id") - getJsonNumber(a, "id"));
  if (matching.length === 0) fail();
  const latest = matching[0];
  const runId = getJsonNumber(latest, "id");
  const jobs = await reader.get(
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`
  );
  return verifyPrivateCiEvidence(identity, runs, jobs);
}

export type NativePrivateCiRequest = {
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  targetBranch?: "main" | "dev";
  linuxShards: readonly string[];
  hasWindows: boolean;
};

/** Validate immutable PR and merge parents before accepting source-owned CI results. */
export async function fetchAndVerifyPrivateCiForPull(
  reader: { get(path: string): Promise<unknown> },
  request: NativePrivateCiRequest
): Promise<VerifiedPrivateCi> {
  if (
    (request.targetBranch !== undefined &&
      request.targetBranch !== "main" &&
      request.targetBranch !== "dev") ||
    !repositoryPattern.test(request.repository) ||
    !Number.isSafeInteger(request.prNumber) ||
    request.prNumber < 1 ||
    !shaPattern.test(request.baseSha) ||
    !shaPattern.test(request.headSha) ||
    !shaPattern.test(request.mergeSha)
  ) {
    fail();
  }
  const repo = request.repository;
  const [repository, pull, merge] = await Promise.all([
    reader.get(`repos/${repo}`),
    reader.get(`repos/${repo}/pulls/${request.prNumber}`),
    reader.get(`repos/${repo}/git/commits/${request.mergeSha}`),
  ]);
  if (
    !isJsonRecord(repository) ||
    repository.private !== true ||
    getJsonString(repository, "full_name") !== repo ||
    !isJsonRecord(pull) ||
    getJsonNumber(pull, "number") !== request.prNumber ||
    getJsonString(pull, "state") !== "open" ||
    !isJsonRecord(pull.base) ||
    !isJsonRecord(pull.head) ||
    getJsonString(pull.base, "ref") !== (request.targetBranch ?? "main") ||
    getJsonString(pull.base, "sha") !== request.baseSha ||
    getJsonString(pull.head, "sha") !== request.headSha ||
    !isJsonRecord(pull.base.repo) ||
    !isJsonRecord(pull.head.repo) ||
    getJsonString(pull.base.repo, "full_name") !== repo ||
    getJsonString(pull.head.repo, "full_name") !== repo ||
    !isJsonRecord(merge) ||
    getJsonString(merge, "sha") !== request.mergeSha
  ) {
    fail();
  }
  const parents = getJsonArray(merge, "parents");
  if (
    parents.length !== 2 ||
    getJsonString(parents[0], "sha") !== request.baseSha ||
    getJsonString(parents[1], "sha") !== request.headSha
  ) {
    fail();
  }
  const identity: PrivateCiIdentity = {
    repository: repo,
    prNumber: request.prNumber,
    baseSha: request.baseSha,
    headSha: request.headSha,
    headBranch: getJsonString(pull.head, "ref"),
    ...(request.targetBranch ? { targetBranch: request.targetBranch } : {}),
    linuxShards: request.linuxShards,
    hasWindows: request.hasWindows,
  };
  return await fetchAndVerifyPrivateCiEvidence(reader, identity);
}
