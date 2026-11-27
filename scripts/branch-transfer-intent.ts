import { createHash } from "node:crypto";
import type { JsonReader } from "./ci-evidence.ts";
import { type PrCiScope, prCiScopeDescription, readCurrentTransferScope } from "./ci-scope-receipt.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { evaluatePrTrust } from "./pr-trust.ts";
import { isManagedTransferDirection } from "./resolve-pr-facts.ts";
import { CliError } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type TransferIntent = {
  repository: string;
  prNumber: number;
  targetBranch: "main" | "dev";
  baseSha: string;
  sourceSha: string;
  treeSha: string;
  basisSha: string;
  mode: "source-tree" | "merge-tree" | "no-change";
};

export type TransferPlan =
  | { kind: "direct"; scope: PrCiScope; title: string }
  | { kind: "staged" | "noop"; intent: TransferIntent; title: string };

export function sourceBranchOf(target: "main" | "dev"): "main" | "dev" {
  return target === "main" ? "dev" : "main";
}

export function validateTransferIntent(value: unknown): TransferIntent {
  if (
    !isJsonRecord(value) ||
    !repositoryPattern.test(getJsonString(value, "repository")) ||
    !Number.isSafeInteger(value.prNumber) ||
    getJsonNumber(value, "prNumber") < 1 ||
    (value.targetBranch !== "main" && value.targetBranch !== "dev") ||
    (value.mode !== "source-tree" && value.mode !== "merge-tree" && value.mode !== "no-change") ||
    !["baseSha", "sourceSha", "treeSha", "basisSha"].every((key) =>
      shaPattern.test(getJsonString(value, key))
    )
  ) {
    throw new CliError("Invalid managed transfer intent.", 75);
  }
  return {
    repository: getJsonString(value, "repository"),
    prNumber: getJsonNumber(value, "prNumber"),
    targetBranch: value.targetBranch,
    baseSha: getJsonString(value, "baseSha"),
    sourceSha: getJsonString(value, "sourceSha"),
    treeSha: getJsonString(value, "treeSha"),
    basisSha: getJsonString(value, "basisSha"),
    mode: value.mode,
  };
}

export function transferIntentDescription(intent: TransferIntent): string {
  const value = validateTransferIntent(intent);
  // A regenerated native merge commit is equivalent only if its exact parents and tree
  // are independently verified. Its timestamp-dependent SHA is not part of the semantic intent.
  const digest = createHash("sha256")
    .update(JSON.stringify([
      "action-worker-transfer-intent-v1",
      value.repository,
      value.prNumber,
      value.targetBranch,
      value.baseSha,
      value.sourceSha,
      value.treeSha,
      value.mode,
      value.mode === "merge-tree" ? "" : value.basisSha,
    ]))
    .digest("base64url");
  return `intent-v1=${digest}`;
}

export function transferPlanDescription(plan: TransferPlan): string {
  return plan.kind === "direct"
    ? prCiScopeDescription(plan.scope)
    : transferIntentDescription(plan.intent);
}

export function commitTree(sha: string, value: unknown): string {
  const tree = isJsonRecord(value) ? getJsonString(value.tree, "sha") : "";
  if (getJsonString(value, "sha") !== sha || !shaPattern.test(tree)) {
    throw new CliError("Transfer commit tree is not independently verified.", 75);
  }
  return tree;
}

export function mergeTree(scope: PrCiScope, value: unknown): string {
  if (
    !isJsonRecord(value) ||
    !Array.isArray(value.parents) ||
    value.parents.length !== 2 ||
    getJsonString(value.parents[0], "sha") !== scope.baseSha ||
    getJsonString(value.parents[1], "sha") !== scope.headSha
  ) {
    throw new CliError("Transfer merge tree has unexpected parents.", 75);
  }
  return commitTree(scope.mergeSha, value);
}

export function isAncestorComparison(compare: unknown, ancestor: string): boolean {
  return (
    isJsonRecord(compare) &&
    (compare.status === "ahead" || compare.status === "identical") &&
    compare.behind_by === 0 &&
    Number.isSafeInteger(compare.ahead_by) &&
    Number(compare.ahead_by) >= 0 &&
    getJsonString(compare.merge_base_commit, "sha") === ancestor
  );
}

async function findSourceTreeAnchor(
  reader: JsonReader,
  repository: string,
  sourceSha: string,
  targetTree: string
): Promise<string | undefined> {
  const prefix = `repos/${repository}`;
  for (let page = 1; page <= 5; page += 1) {
    const rows = await reader.get(`${prefix}/commits?sha=${sourceSha}&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new CliError("Source history is not readable.", 75);
    for (const row of rows) {
      if (!isJsonRecord(row)) throw new CliError("Invalid source history entry.", 75);
      const sha = getJsonString(row, "sha");
      const tree = isJsonRecord(row.commit) ? getJsonString(row.commit.tree, "sha") : "";
      if (!shaPattern.test(sha) || !shaPattern.test(tree)) {
        throw new CliError("Incomplete source history entry.", 75);
      }
      if (tree !== targetTree) continue;
      if (
        commitTree(sha, await reader.get(`${prefix}/git/commits/${sha}`)) !== targetTree ||
        !isAncestorComparison(await reader.get(`${prefix}/compare/${sha}...${sourceSha}`), sha)
      ) {
        throw new CliError("Source tree anchor is not an ancestor of the locked source.", 75);
      }
      return sha;
    }
    if (rows.length < 100) return undefined;
  }
  return undefined;
}

/** Plan from live protected refs, not from a caller-selected tree or a stale PR diff. */
export async function readTransferPlan(
  reader: JsonReader,
  repository: string,
  prNumber: number,
  sourceSha: string
): Promise<TransferPlan> {
  const prefix = `repos/${repository}`;
  if (!repositoryPattern.test(repository) || !Number.isSafeInteger(prNumber) || prNumber < 1 || !shaPattern.test(sourceSha)) {
    throw new CliError("Invalid managed transfer request.", 75);
  }
  const pull = await reader.get(`${prefix}/pulls/${prNumber}`);
  if (
    !isJsonRecord(pull) ||
    pull.number !== prNumber ||
    pull.state !== "open" ||
    pull.draft !== false ||
    !isManagedTransferDirection(pull, repository) ||
    getJsonString(pull.head, "sha") !== sourceSha ||
    !evaluatePrTrust(pull, [], sourceSha).trusted
  ) {
    throw new CliError("Original managed transfer PR is no longer admissible.", 75);
  }
  const targetBranch = getJsonString(pull.base, "ref");
  if (targetBranch !== "main" && targetBranch !== "dev") {
    throw new CliError("Invalid managed target branch.", 75);
  }
  const title = getJsonString(pull, "title").replace(/[\r\n]/g, " ");
  const target = await reader.get(`${prefix}/branches/${targetBranch}`);
  const source = await reader.get(`${prefix}/branches/${sourceBranchOf(targetBranch)}`);
  const baseSha = isJsonRecord(target) ? getJsonString(target.commit, "sha") : "";
  if (
    !title ||
    !shaPattern.test(baseSha) ||
    getJsonString(pull.base, "sha") !== baseSha ||
    !isJsonRecord(source) ||
    getJsonString(source.commit, "sha") !== sourceSha
  ) {
    throw new CliError("Original managed transfer refs changed.", 75);
  }
  const baseTree = commitTree(baseSha, await reader.get(`${prefix}/git/commits/${baseSha}`));
  const sourceTree = commitTree(sourceSha, await reader.get(`${prefix}/git/commits/${sourceSha}`));
  const intent = (mode: TransferIntent["mode"], treeSha: string, basisSha: string): TransferIntent => ({
    repository, prNumber, targetBranch, baseSha, sourceSha, treeSha, basisSha, mode,
  });
  if (baseTree === sourceTree) {
    return { kind: "noop", intent: intent("no-change", baseTree, sourceSha), title };
  }
  const comparison = await reader.get(`${prefix}/compare/${baseSha}...${sourceSha}`);
  if (!isJsonRecord(comparison)) throw new CliError("Transfer comparison is unavailable.", 75);
  if (comparison.status === "behind" && comparison.ahead_by === 0 &&
      getJsonNumber(comparison, "behind_by") > 0 &&
      getJsonString(comparison.merge_base_commit, "sha") === sourceSha) {
    return { kind: "noop", intent: intent("no-change", baseTree, sourceSha), title };
  }
  if (comparison.status === "ahead" && isAncestorComparison(comparison, baseSha)) {
    const scope = await readCurrentTransferScope(reader, repository, prNumber, sourceSha);
    if (!scope || scope.baseSha !== baseSha) throw new CliError("Direct transfer snapshot is not ready.", 75);
    return { kind: "direct", scope, title };
  }
  if (
    comparison.status !== "diverged" ||
    getJsonNumber(comparison, "ahead_by") < 1 ||
    getJsonNumber(comparison, "behind_by") < 1 ||
    !shaPattern.test(getJsonString(comparison.merge_base_commit, "sha"))
  ) {
    throw new CliError("Transfer ancestry comparison is inconsistent.", 75);
  }
  // Squash may destroy ancestry without changing content. When the current target tree
  // already occurs on the source history, the source tree includes the target baseline.
  // This avoids a spurious native three-way conflict against the old graph merge base.
  const anchor = await findSourceTreeAnchor(reader, repository, sourceSha, baseTree);
  if (anchor) {
    return { kind: "staged", intent: intent("source-tree", sourceTree, anchor), title };
  }
  // If the target has independent content, use only GitHub's verified clean integrated tree.
  // Never replace target-only changes or resolve a content conflict by preferring one branch.
  if (pull.mergeable === true && pull.mergeable_state !== "dirty") {
    const scope = await readCurrentTransferScope(reader, repository, prNumber, sourceSha);
    if (scope && scope.baseSha === baseSha) {
      const tree = mergeTree(scope, await reader.get(`${prefix}/git/commits/${scope.mergeSha}`));
      if (tree === baseTree) return { kind: "noop", intent: intent("no-change", tree, scope.mergeSha), title };
      return { kind: "staged", intent: intent("merge-tree", tree, scope.mergeSha), title };
    }
  }
  throw new CliError(
    "Diverged transfer has no verified common-content anchor or clean merge tree; reconcile content conflicts in a reviewed task branch.",
    75
  );
}

export function transferStageRef(intent: TransferIntent, runId: number): string {
  validateTransferIntent(intent);
  if (!Number.isSafeInteger(runId) || runId < 1 || intent.mode === "no-change") {
    throw new CliError("Invalid staging run or empty transfer.", 75);
  }
  return `aw-transfer/${sourceBranchOf(intent.targetBranch)}/${intent.prNumber}/${runId}`;
}

const stageMessagePrefix = "Action Worker authorized transfer\n\n";

export function transferStageMessage(intent: TransferIntent): string {
  return stageMessagePrefix + JSON.stringify(validateTransferIntent(intent));
}

export function intentFromStageCommit(commit: unknown): TransferIntent {
  const message = getJsonString(commit, "message");
  if (!message.startsWith(stageMessagePrefix)) throw new CliError("Missing staging intent.", 75);
  return validateTransferIntent(JSON.parse(message.slice(stageMessagePrefix.length)));
}

/** Independently verify the original source, target and the selected immutable content basis. */
export async function verifyIntentObjects(reader: JsonReader, intent: TransferIntent): Promise<void> {
  const value = validateTransferIntent(intent);
  const prefix = `repos/${value.repository}`;
  const baseTree = commitTree(value.baseSha, await reader.get(`${prefix}/git/commits/${value.baseSha}`));
  const sourceTree = commitTree(value.sourceSha, await reader.get(`${prefix}/git/commits/${value.sourceSha}`));
  const basis = await reader.get(`${prefix}/git/commits/${value.basisSha}`);
  if (value.mode === "source-tree") {
    if (
      commitTree(value.basisSha, basis) !== baseTree ||
      sourceTree !== value.treeSha ||
      !isAncestorComparison(
        await reader.get(`${prefix}/compare/${value.basisSha}...${value.sourceSha}`),
        value.basisSha
      )
    ) {
      throw new CliError("Staged transfer source tree no longer proves the target content baseline.", 75);
    }
  } else if (value.mode === "merge-tree") {
    if (
      mergeTree({
        repository: value.repository, prNumber: value.prNumber, targetBranch: value.targetBranch,
        baseSha: value.baseSha, headSha: value.sourceSha, mergeSha: value.basisSha,
      }, basis) !== value.treeSha
    ) {
      throw new CliError("Staged transfer does not match the integrated merge tree.", 75);
    }
  } else {
    throw new CliError("An empty transfer must never create a staging commit.", 75);
  }
  if (baseTree === value.treeSha) throw new CliError("Staged transfer has no content change.", 75);
}
