import { execFileSync } from "node:child_process";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;

export type CheckoutSnapshot = {
  prNumber: string;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  checkedOutSha: string;
  parents: readonly string[];
};

/**
 * Fail closed if the code tested is not exactly the immutable snapshot approved by prepare.
 * GitHub's refs/pull/<number>/merge is mutable, so the sandbox must never checkout that ref.
 */
export function verifyPinnedCheckout(snapshot: CheckoutSnapshot): void {
  const { prNumber, baseSha, headSha, mergeSha, checkedOutSha, parents } = snapshot;
  if (!shaPattern.test(headSha) || !shaPattern.test(checkedOutSha)) {
    throw new CliError("::error::CI checkout verification received an invalid commit SHA.", 65);
  }
  if (prNumber === "0") {
    if (checkedOutSha !== headSha) {
      throw new CliError(
        "::error::Branch CI checked out a different commit than the requested head.",
        75
      );
    }
    return;
  }
  if (!/^[1-9][0-9]*$/.test(prNumber) || !shaPattern.test(baseSha) || !shaPattern.test(mergeSha)) {
    throw new CliError("::error::PR CI checkout snapshot is incomplete or invalid.", 65);
  }
  if (checkedOutSha !== mergeSha) {
    throw new CliError(
      "::error::PR CI checked out a different merge commit than the pinned snapshot.",
      75
    );
  }
  // GitHub's synthetic PR merge commit has exactly two parents: base, then PR head.
  if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
    throw new CliError(
      "::error::PR CI merge parents do not match the approved base and head; rerun Central CI.",
      75
    );
  }
}

function main(): void {
  const [target = "", prNumber = "", baseSha = "", headSha = "", mergeSha = ""] =
    process.argv.slice(2);
  if (!target || !prNumber) {
    throw new CliError(
      "Usage: verify-ci-checkout.ts <target-dir> <pr-number> <base-sha> <head-sha> <merge-sha>",
      64
    );
  }
  const output = execFileSync("git", ["-C", target, "rev-list", "--parents", "-n", "1", "HEAD"], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  const [checkedOutSha = "", ...parents] = output.split(/\s+/);
  verifyPinnedCheckout({ prNumber, baseSha, headSha, mergeSha, checkedOutSha, parents });
  console.log("Central CI checkout snapshot verified.");
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    handleError(error);
  }
}
