import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  decodeGithubContent,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowPath = ".github/workflows/private-ref-ci.yml";
const jobPrefix = "Private main source verification / ";

export type PrivateRefIdentity = {
  repository: string;
  headSha: string;
  beforeSha: string;
  linuxShards: readonly string[];
  hasWindows: boolean;
};

export type VerifiedPrivateRef = { runId: number; runAttempt: number };

function fail(): never {
  throw new CliError("Private main CI evidence is missing, stale or incomplete.", 65);
}

function validateIdentity(value: PrivateRefIdentity): void {
  if (
    !repositoryPattern.test(value.repository) ||
    !shaPattern.test(value.headSha) ||
    !shaPattern.test(value.beforeSha) ||
    value.headSha === value.beforeSha ||
    value.linuxShards.length < 1 ||
    value.linuxShards.length > 8 ||
    new Set(value.linuxShards).size !== value.linuxShards.length ||
    value.linuxShards.some((s) => !/^[a-z][a-z0-9-]{0,31}$/.test(s))
  ) {
    fail();
  }
}

function runMatches(run: unknown, identity: PrivateRefIdentity): boolean {
  if (!isJsonRecord(run)) return false;
  const repo = run.repository;
  const title = `private-ref-${identity.headSha}`;
  return (
    isJsonRecord(repo) &&
    getJsonString(repo, "full_name") === identity.repository &&
    getJsonNumber(repo, "id") > 0 &&
    getJsonNumber(run, "workflow_id") > 0 &&
    Number.isSafeInteger(getJsonNumber(run, "id")) &&
    getJsonNumber(run, "id") > 0 &&
    getJsonString(run, "name") === title &&
    getJsonString(run, "display_title") === title &&
    getJsonString(run, "path") === workflowPath &&
    getJsonString(run, "event") === "push" &&
    getJsonString(run, "head_branch") === "main" &&
    getJsonString(run, "head_sha") === identity.headSha
  );
}

export function verifyPrivateRefEvidence(
  identity: PrivateRefIdentity,
  runResponse: unknown,
  jobsResponse: unknown
): VerifiedPrivateRef {
  validateIdentity(identity);
  if (!isJsonRecord(runResponse) || !Array.isArray(runResponse.workflow_runs)) fail();
  const runs = getJsonArray(runResponse, "workflow_runs");
  if (
    typeof runResponse.total_count !== "number" ||
    !Number.isSafeInteger(runResponse.total_count) ||
    runResponse.total_count < 0 ||
    runResponse.total_count > runs.length
  ) {
    fail();
  }
  const matching = runs.filter((r) => runMatches(r, identity));
  if (matching.length < 1) fail();
  const sorted = matching.sort((a, b) => getJsonNumber(b, "id") - getJsonNumber(a, "id"));
  const selected = sorted[0];
  if (
    !isJsonRecord(selected) ||
    getJsonString(selected, "status") !== "completed" ||
    getJsonString(selected, "conclusion") !== "success"
  ) {
    fail();
  }
  const id = getJsonNumber(selected, "id");
  const attempt = getJsonNumber(selected, "run_attempt");
  if (!Number.isSafeInteger(attempt) || attempt < 1) fail();
  if (!isJsonRecord(jobsResponse) || !Array.isArray(jobsResponse.jobs)) fail();
  const jobs = getJsonArray(jobsResponse, "jobs");
  if (
    typeof jobsResponse.total_count !== "number" ||
    !Number.isSafeInteger(jobsResponse.total_count) ||
    jobsResponse.total_count !== jobs.length
  ) {
    fail();
  }
  const expected = new Set([
    `${jobPrefix}Verify protected private main and CI plan`,
    `${jobPrefix}Private main security and dependencies`,
    ...identity.linuxShards.map((s) => `${jobPrefix}Private main Linux (${s})`),
    `${jobPrefix}Private main Windows`,
    `${jobPrefix}Private main CI complete`,
  ]);
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!isJsonRecord(job)) fail();
    const name = getJsonString(job, "name");
    if (
      !expected.has(name) ||
      seen.has(name) ||
      getJsonNumber(job, "run_id") !== id ||
      getJsonString(job, "status") !== "completed"
    ) {
      fail();
    }
    const conclusion = getJsonString(job, "conclusion");
    if (name === `${jobPrefix}Private main Windows` && !identity.hasWindows) {
      if (conclusion !== "skipped") fail();
    } else if (conclusion !== "success") {
      fail();
    }
    seen.add(name);
  }
  if (seen.size !== expected.size) fail();
  return { runId: id, runAttempt: attempt };
}

export async function fetchAndVerifyPrivateRef(
  reader: { get(path: string): Promise<unknown> },
  identity: PrivateRefIdentity
): Promise<VerifiedPrivateRef> {
  validateIdentity(identity);
  const repo = identity.repository;
  const [repository, branch, commit, caller, policyString] = await Promise.all([
    reader.get(`repos/${repo}`),
    reader.get(`repos/${repo}/git/ref/heads/main`),
    reader.get(`repos/${repo}/git/commits/${identity.headSha}`),
    reader.get(`repos/${repo}/contents/${workflowPath}?ref=${identity.headSha}`),
    readFile("policies/private-ref-callers.json", "utf8"),
  ]);
  if (
    !isJsonRecord(repository) ||
    repository.private !== true ||
    getJsonString(repository, "full_name") !== repo ||
    getJsonString(repository, "default_branch") !== "main" ||
    !isJsonRecord(branch) ||
    !isJsonRecord(branch.object) ||
    getJsonString(branch.object, "sha") !== identity.headSha ||
    !isJsonRecord(commit) ||
    getJsonString(commit, "sha") !== identity.headSha
  ) {
    fail();
  }
  const parents = getJsonArray(commit, "parents");
  if (parents.length !== 1 || getJsonString(parents[0], "sha") !== identity.beforeSha) fail();
  const policy: unknown = JSON.parse(policyString);
  if (!isJsonRecord(policy) || policy.schema_version !== 1) fail();
  const approved = getJsonArray(policy, "callers").filter(
    (entry) =>
      isJsonRecord(entry) &&
      getJsonString(entry, "repository") === repo &&
      getJsonString(entry, "path") === workflowPath
  );
  if (approved.length !== 1 || !isJsonRecord(caller)) fail();
  if (getJsonString(caller, "type") !== "file" || getJsonString(caller, "path") !== workflowPath) {
    fail();
  }
  const expectedHash = getJsonString(approved[0], "sha256");
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) fail();
  const content = decodeGithubContent(caller);
  const actualHash = createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
  if (actualHash !== expectedHash) fail();

  const runs = await reader.get(
    `repos/${repo}/actions/workflows/private-ref-ci.yml/runs?event=push&head_sha=${identity.headSha}&per_page=100`
  );
  if (!isJsonRecord(runs)) fail();
  const matches = getJsonArray(runs, "workflow_runs")
    .filter((run) => runMatches(run, identity))
    .sort((a, b) => getJsonNumber(b, "id") - getJsonNumber(a, "id"));
  if (matches.length === 0) fail();
  const jobs = await reader.get(
    `repos/${repo}/actions/runs/${getJsonNumber(matches[0], "id")}/jobs?per_page=100&filter=latest`
  );
  return verifyPrivateRefEvidence(identity, runs, jobs);
}
