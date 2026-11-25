import { createHash } from "node:crypto";
import { getGithubJsonIfExists, getJsonString, isJsonRecord } from "./github-api.ts";
import { isGovernedPullDirection, isManagedBranchRef } from "./resolve-pr-facts.ts";
import { CliError } from "./runtime-command.ts";

export type PrCiScope = {
  repository: string;
  prNumber: number;
  targetBranch: string;
  baseSha: string;
  headSha: string;
  mergeSha: string;
};

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// The complete immutable scope is represented by a fixed-length digest inside the
// signed GitHub status description. It fits even the maximum signing key ID.
export function prCiScopeDescription(scope: PrCiScope): string {
  if (
    !repositoryPattern.test(scope.repository) ||
    !Number.isSafeInteger(scope.prNumber) ||
    scope.prNumber < 1 ||
    !["main", "dev"].includes(scope.targetBranch) ||
    ![scope.baseSha, scope.headSha, scope.mergeSha].every((sha) => shaPattern.test(sha))
  ) {
    throw new CliError("Invalid PR CI snapshot scope.", 65);
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "action-worker-pr-ci-scope-v1",
        scope.repository.toLowerCase(),
        scope.prNumber,
        scope.targetBranch,
        scope.baseSha,
        scope.headSha,
        scope.mergeSha,
      ])
    )
    .digest("base64url");
  return `scope-v1=${digest}`;
}

/** Resolve the live, independently observed merge snapshot, not a caller-supplied SHA. */
export async function readCurrentPrCiScope(
  reader: { get(path: string): Promise<unknown> },
  repository: string,
  prNumber: number,
  headSha: string,
  targetBranch = "main"
): Promise<PrCiScope | undefined> {
  return readPrSnapshot(reader, repository, prNumber, headSha, (pull) => {
    if (!isGovernedPullDirection(pull, targetBranch)) return false;
    if (targetBranch !== "dev") return true;
    return isJsonRecord(pull.head) && getJsonString(pull.head.repo, "full_name") === repository;
  });
}

export async function readCurrentTransferScope(
  reader: { get(path: string): Promise<unknown> },
  repository: string,
  prNumber: number,
  headSha: string
): Promise<PrCiScope | undefined> {
  return readPrSnapshot(
    reader,
    repository,
    prNumber,
    headSha,
    (pull) => {
      const head = isJsonRecord(pull.head) ? pull.head : {};
      const base = isJsonRecord(pull.base) ? pull.base : {};
      const source = getJsonString(head, "ref");
      const target = getJsonString(base, "ref");
      return (
        isManagedBranchRef(source) &&
        isManagedBranchRef(target) &&
        source !== target &&
        getJsonString(head.repo, "full_name") === repository
      );
    },
    true
  );
}

async function readPrSnapshot(
  reader: { get(path: string): Promise<unknown> },
  repository: string,
  prNumber: number,
  headSha: string,
  isDirectionAllowed: (pull: Record<string, unknown>) => boolean,
  isTransfer = false
): Promise<PrCiScope | undefined> {
  if (
    !repositoryPattern.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !shaPattern.test(headSha)
  ) {
    throw new CliError("Invalid PR CI scope request.", 65);
  }
  const pull = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  if (
    !isJsonRecord(pull) ||
    pull.state !== "open" ||
    !isDirectionAllowed(pull) ||
    getJsonString(pull.head, "sha") !== headSha ||
    !isJsonRecord(pull.base) ||
    getJsonString(pull.base.repo, "full_name") !== repository
  ) {
    throw new CliError("PR CI scope no longer matches the admitted pull request.", 75);
  }
  const targetBranch = getJsonString(pull.base, "ref");
  if (isTransfer) {
    const source = targetBranch === "main" ? "dev" : "main";
    const sourceBranch = await reader.get(`repos/${repository}/branches/${source}`);
    if (!isJsonRecord(sourceBranch) || getJsonString(sourceBranch.commit, "sha") !== headSha) {
      return undefined;
    }
  }
  const branch = await reader.get(`repos/${repository}/branches/${targetBranch}`);
  const baseSha = isJsonRecord(branch) ? getJsonString(branch.commit, "sha") : "";
  const mergeRef = await getGithubJsonIfExists(
    `repos/${repository}/git/ref/pull/${prNumber}/merge`,
    (path) => reader.get(path)
  );
  const mergeSha = isJsonRecord(mergeRef) ? getJsonString(mergeRef.object, "sha") : "";
  if (!shaPattern.test(baseSha) || !shaPattern.test(mergeSha)) return undefined;
  const merge = await getGithubJsonIfExists(`repos/${repository}/git/commits/${mergeSha}`, (path) =>
    reader.get(path)
  );
  if (
    !isJsonRecord(merge) ||
    getJsonString(merge, "sha") !== mergeSha ||
    !Array.isArray(merge.parents) ||
    merge.parents.length !== 2 ||
    getJsonString(merge.parents[0], "sha") !== baseSha ||
    getJsonString(merge.parents[1], "sha") !== headSha
  ) {
    return undefined;
  }
  return { repository, prNumber, targetBranch, baseSha, headSha, mergeSha };
}
