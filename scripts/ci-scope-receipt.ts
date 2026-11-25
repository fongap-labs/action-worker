import { createHash } from "node:crypto";
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
