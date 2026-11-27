import { getJsonArray, getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { isReservedMergeSourceRef, stagedTransferSource } from "./resolve-pr-facts.ts";
import { CliError } from "./runtime-command.ts";

export type ManagedBranch = "main" | "dev";

export function managedBranchLabel(branch: ManagedBranch): "Main" | "Dev" {
  if (branch === "main") return "Main";
  if (branch === "dev") return "Dev";
  throw new CliError("Invalid managed branch.", 65);
}

export function managedBranchWriteContext(branch: ManagedBranch): string {
  return `${managedBranchLabel(branch)} Write Guard`;
}

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function baseRef(value: unknown): string {
  return isJsonRecord(value) ? getJsonString(value.base, "ref") : "";
}

function headSha(value: unknown): string {
  return isJsonRecord(value) ? getJsonString(value.head, "sha") : "";
}

/**
 * GitHub may omit a valid squash-merge commit from commits/{sha}/pulls.
 * The final "(#number)" in the signed commit subject is only a lookup hint.
 * The referenced PR must independently prove the exact merge SHA and base branch.
 */
function mergedPrNumberHint(commit: unknown): number | null {
  const details = isJsonRecord(commit) ? commit.commit : undefined;
  const subject = getJsonString(details, "message").split("\n", 1)[0] ?? "";
  const match = /\(#([1-9][0-9]*)\)$/.exec(subject);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

/** Only proves merge attribution. Callers must independently enforce branch-specific CI and authorization. */
export async function resolveManagedBranchMerge(
  reader: { get(path: string): Promise<unknown> },
  repository: string,
  targetBranch: ManagedBranch,
  writeSha: string,
  commit: unknown
): Promise<{ pr_number: number; pr_head_sha: string; managed_source?: ManagedBranch }> {
  if (
    !repositoryPattern.test(repository) ||
    (targetBranch !== "main" && targetBranch !== "dev") ||
    !shaPattern.test(writeSha) ||
    getJsonString(commit, "sha") !== writeSha
  ) {
    throw new CliError("::error::Invalid managed branch merge attribution input.", 65);
  }
  const associated = getJsonArray(
    await reader.get(`repos/${repository}/commits/${writeSha}/pulls?per_page=100`)
  );
  const isExactMerge = (value: unknown): boolean =>
    isJsonRecord(value) &&
    getJsonString(value, "merged_at") !== "" &&
    getJsonString(value, "merge_commit_sha") === writeSha &&
    baseRef(value) === targetBranch &&
    getJsonNumber(value, "number") > 0;
  const candidates = associated.filter(isExactMerge);

  // The reverse association API sometimes omits freshly merged squash commits.
  // Never infer trust from the commit subject alone: verify the claimed PR via
  // its own endpoint and require an exact, immutable merge SHA match.
  let fallbackPr: unknown;
  if (associated.length === 0 && candidates.length === 0) {
    const hint = mergedPrNumberHint(commit);
    if (hint !== null) {
      fallbackPr = await reader.get(`repos/${repository}/pulls/${hint}`);
      if (isExactMerge(fallbackPr) && getJsonNumber(fallbackPr, "number") === hint) {
        candidates.push(fallbackPr);
      }
    }
  }

  if (candidates.length !== 1) {
    throw new CliError(
      `::error::${targetBranch === "main" ? "Main" : "Dev"} SHA is not uniquely attributable to a merged pull request: ${repository}@${writeSha}.`,
      65
    );
  }

  const associatedPr = candidates[0];
  const prNumber = getJsonNumber(associatedPr, "number");
  // GitHub's commit-associated merged PR already contains the exact merge SHA,
  // base branch, and PR head. Re-fetch only if the head is missing/invalid.
  // The commit-message fallback still requires a separate, exact PR GET.
  const pr =
    fallbackPr ??
    (shaPattern.test(headSha(associatedPr))
      ? associatedPr
      : await reader.get(`repos/${repository}/pulls/${prNumber}`));
  const prHeadSha = headSha(pr);
  if (
    getJsonNumber(pr, "number") !== prNumber ||
    getJsonString(pr, "merged_at") === "" ||
    getJsonString(pr, "merge_commit_sha") !== writeSha ||
    baseRef(pr) !== targetBranch ||
    !shaPattern.test(prHeadSha)
  ) {
    throw new CliError(
      `::error::Merged pull request facts do not match the ${targetBranch} write.`,
      65
    );
  }

  const source = isJsonRecord(pr) ? getJsonString(pr.head, "ref") : "";
  const managedSource = source === "main" || source === "dev" ? source : stagedTransferSource(source);
  if (isReservedMergeSourceRef(source) && !managedSource) {
    throw new CliError("Invalid reserved transfer source; ordinary write attribution is forbidden.", 65);
  }
  return {
    pr_number: prNumber,
    pr_head_sha: prHeadSha,
    ...(managedSource ? { managed_source: managedSource } : {}),
  };
}
