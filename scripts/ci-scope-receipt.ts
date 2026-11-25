import { createHash } from "node:crypto";
import { getGithubJsonIfExists, getJsonString, isJsonRecord } from "./github-api.ts";
import { isGovernedPullDirection } from "./resolve-pr-facts.ts";
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
  headSha: string
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
    !isGovernedPullDirection(pull) ||
    getJsonString(pull.head, "sha") !== headSha ||
    !isJsonRecord(pull.base) ||
    getJsonString(pull.base.repo, "full_name") !== repository
  ) {
    throw new CliError("PR CI scope no longer matches the admitted pull request.", 75);
  }
  const targetBranch = getJsonString(pull.base, "ref");
  const branch = await reader.get(`repos/${repository}/branches/${targetBranch}`);
  const baseSha = isJsonRecord(branch) ? getJsonString(branch.commit, "sha") : "";
  const mergeRef = await getGithubJsonIfExists(
    `repos/${repository}/git/ref/pull/${prNumber}/merge`,
    (path) => reader.get(path)
  );
  const mergeSha = isJsonRecord(mergeRef) ? getJsonString(mergeRef.object, "sha") : "";
  if (!shaPattern.test(baseSha) || !shaPattern.test(mergeSha)) return undefined;
  const merge = await getGithubJsonIfExists(
    `repos/${repository}/git/commits/${mergeSha}`,
    (path) => reader.get(path)
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
