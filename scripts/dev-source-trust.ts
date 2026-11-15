import {
  controlRepositoryOf,
  hasVerifiedCiEvidence,
  hasVerifiedControlStatus,
  type JsonReader,
  prGateWorkflowPaths,
} from "./ci-evidence.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { CliError } from "./runtime-command.ts";
import { latestAttestedStatus, originalStatusDescription } from "./status-attestation.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isExactDevMerge(value: unknown, sha: string): boolean {
  if (!isJsonRecord(value)) return false;
  return (
    getJsonString(value, "merged_at") !== "" &&
    getJsonString(value, "merge_commit_sha") === sha &&
    getJsonString(value.base, "ref") === "dev" &&
    getJsonNumber(value, "number") > 0
  );
}

function mergedPrHint(commit: unknown): number | null {
  const description = isJsonRecord(commit) ? getJsonString(commit.commit, "message") : "";
  const match = /\(#([1-9][0-9]*)\)$/.exec(description.split("\n", 1)[0] ?? "");
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

export type VerifiedDevSource = {
  dev_sha: string;
  pr_number: number;
  pr_head_sha: string;
};

/**
 * The only dev commit eligible for Beta is the current dev HEAD, created by an
 * exact merged PR targeting dev whose reviewed head passed authenticated
 * Action Worker PR governance, central CI and validate-merge.
 * A direct push, an earlier SHA, a main merge or an unverified PR is refused.
 */
export async function assertTrustedDevSource(
  reader: JsonReader,
  repository: string,
  sha: string
): Promise<VerifiedDevSource> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(sha)) {
    throw new CliError("Beta source identity is invalid.", 64);
  }
  const repo = await reader.get(`repos/${repository}`);
  if (getJsonString(repo, "default_branch") !== "main") {
    throw new CliError("Beta source repository must keep main as its default branch.", 77);
  }
  const branch = await reader.get(`repos/${repository}/git/ref/heads/dev`);
  if (
    getJsonString(branch, "ref") !== "refs/heads/dev" ||
    getJsonString(isJsonRecord(branch) ? branch.object : undefined, "sha") !== sha
  ) {
    throw new CliError("Beta source must equal the current dev HEAD.", 75);
  }
  const commit = await reader.get(`repos/${repository}/commits/${sha}`);
  if (getJsonString(commit, "sha") !== sha) {
    throw new CliError("Beta source commit identity could not be confirmed.", 65);
  }
  const associated = await reader.get(`repos/${repository}/commits/${sha}/pulls?per_page=100`);
  if (!Array.isArray(associated)) {
    throw new CliError("Beta source PR association is unavailable.", 65);
  }
  const matches = associated.filter((pr) => isExactDevMerge(pr, sha));
  if (associated.length === 0) {
    const hint = mergedPrHint(commit);
    if (hint !== null) {
      const candidate = await reader.get(`repos/${repository}/pulls/${hint}`);
      if (isExactDevMerge(candidate, sha) && getJsonNumber(candidate, "number") === hint) {
        matches.push(candidate);
      }
    }
  }
  if (matches.length !== 1) {
    throw new CliError("Beta source must come from one exact merged PR into dev.", 77);
  }
  const pr = matches[0];
  const prNumber = getJsonNumber(pr, "number");
  const fullPr = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  const headSha = getJsonString(isJsonRecord(fullPr) ? fullPr.head : undefined, "sha");
  if (
    !isExactDevMerge(fullPr, sha) ||
    getJsonNumber(fullPr, "number") !== prNumber ||
    !shaPattern.test(headSha)
  ) {
    throw new CliError("Beta source PR merge facts could not be confirmed.", 77);
  }
  const status = await reader.get(`repos/${repository}/commits/${headSha}/status`);
  const title = getJsonString(fullPr, "title");
  if (!title) {
    throw new CliError("Beta source PR title is unavailable.", 77);
  }
  const expectedTitleHash = `title-sha256=${prTitleFingerprint(title)} `;
  const controlRepository = controlRepositoryOf();
  for (const context of ["PR Governance", "validate-merge"] as const) {
    const signed = latestAttestedStatus(status, { repository, sha: headSha, context });
    if (!signed || !originalStatusDescription(signed).startsWith(expectedTitleHash)) {
      throw new CliError(`Beta source ${context} was not verified for the current PR title.`, 77);
    }
    if (!(await hasVerifiedControlStatus(reader, status, context, {
      controlRepository,
      targetRepository: repository,
      targetSha: headSha,
      workflowPaths: prGateWorkflowPaths,
      runAttempts: 1,
    }))) {
      throw new CliError(`Beta source has no verified ${context} on merged PR head.`, 77);
    }
  }
  if (
    !(await hasVerifiedCiEvidence(reader, status, {
      controlRepository,
      targetRepository: repository,
      targetSha: headSha,
      runAttempts: 1,
    }))
  ) {
    throw new CliError("Beta source has no verified central CI on merged PR head.", 77);
  }
  return { dev_sha: sha, pr_number: prNumber, pr_head_sha: headSha };
}
