import { getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain, runText } from "./runtime-command.ts";

// One reviewed exception for Delta's intentionally empty, fresh Git history.
// This is not a general permission to rewrite main or bypass code/CI checks.
export const deltaCleanRootSha = "96d36e875dcd24a28926b9993843ddac9ed11a8f";
export const deltaCleanRootTreeSha = "81ea6bd9875553526e0c808544448bd31ada1047";
const deltaRepository = "fongap-labs/delta";

export function isDeltaCleanRootTarget(repository: string, sha: string): boolean {
  return repository === deltaRepository && sha === deltaCleanRootSha;
}

/** GitHub REST commits have a nested commit.tree; Git commit objects have tree at top level. */
export function verifyDeltaCleanRootCommit(repository: string, sha: string, commit: unknown): void {
  if (!isDeltaCleanRootTarget(repository, sha) || !isJsonRecord(commit)) {
    throw new CliError(
      "Delta clean-root approval is restricted to the pinned repository and SHA.",
      65
    );
  }
  const object = isJsonRecord(commit.commit) ? commit.commit : commit;
  if (
    getJsonString(commit, "sha") !== deltaCleanRootSha ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 0 ||
    !isJsonRecord(object.tree) ||
    getJsonString(object.tree, "sha") !== deltaCleanRootTreeSha
  ) {
    throw new CliError(
      "Delta clean-root commit identity, parents or tree does not match the reviewed initialization.",
      65
    );
  }
}

/** This is an actual static baseline check, never an assertion that app tests ran. */
export async function verifyDeltaCleanRootCheckout(
  repository: string,
  sha: string,
  checkoutRoot: string
): Promise<void> {
  if (!isDeltaCleanRootTarget(repository, sha) || !checkoutRoot) {
    throw new CliError("Delta clean-root checkout is not an approved target.", 65);
  }
  const [actualSha, tree, files] = await Promise.all([
    runText("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot }),
    runText("git", ["rev-parse", "HEAD^{tree}"], { cwd: checkoutRoot }),
    runText("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: checkoutRoot }),
  ]);
  if (
    actualSha.trim() !== deltaCleanRootSha ||
    tree.trim() !== deltaCleanRootTreeSha ||
    files.trim() !== "LICENSE\nREADME.md"
  ) {
    throw new CliError(
      "Delta clean-root checkout differs from the approved two-file baseline.",
      65
    );
  }
  console.log(
    "Delta initial root verified: immutable tree with LICENSE and README.md; no application tests exist."
  );
}

if (isMain(import.meta.url)) {
  const [repository = "", sha = "", checkoutRoot = ""] = process.argv.slice(2);
  verifyDeltaCleanRootCheckout(repository, sha, checkoutRoot).catch(handleError);
}
