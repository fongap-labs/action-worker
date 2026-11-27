import {
  commitTree,
  intentFromStageCommit,
  mergeTree,
  type TransferIntent,
  transferIntentDescription,
  transferStageMessage,
  transferStageRef,
  verifyIntentObjects,
} from "./branch-transfer-intent.ts";
import type { JsonReader } from "./ci-evidence.ts";
import { type PrCiScope, readCurrentStagedTransferScope } from "./ci-scope-receipt.ts";
import { getGithubJsonIfExists, getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { isManagedTransferDirection, isStagedTransferDirection } from "./resolve-pr-facts.ts";
import { CliError } from "./runtime-command.ts";
import {
  latestAttestedStatus,
  originalStatusDescription,
  statusRunAttempt,
} from "./status-attestation.ts";

const shaPattern = /^[0-9a-f]{40}$/;
export const transferPreparationContext = "Transfer Preparation";
type Writer = (
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
) => Promise<unknown>;
type Publish = (
  sha: string,
  context: string,
  state: "success" | "failure",
  description: string
) => Promise<void>;

export function transferStageWriter(token: string): Writer {
  if (!token) throw new CliError("Missing dedicated transfer staging token.", 77);
  const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  return async (method, path, body) => {
    const response = await fetch(`${api}/${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new CliError(`Transfer staging ${method} failed (HTTP ${response.status}).`, 75);
    }
    return response.status === 204 ? undefined : await response.json();
  };
}

function verifyStageCommit(intent: TransferIntent, sha: string, commit: unknown): void {
  if (
    commitTree(sha, commit) !== intent.treeSha ||
    !isJsonRecord(commit) ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    getJsonString(commit.parents[0], "sha") !== intent.baseSha ||
    getJsonString(commit, "message").trimEnd() !== transferStageMessage(intent)
  ) {
    throw new CliError("Staging commit does not match the authorized target parent and tree.", 75);
  }
}

export async function verifyStagedTransferProof(
  reader: JsonReader,
  scope: PrCiScope,
  ref: string,
  runId: number,
  runUrl: string
): Promise<{ intent: TransferIntent; createdAt: number; statuses: unknown }> {
  const prefix = `repos/${scope.repository}`;
  const commit = await reader.get(`${prefix}/git/commits/${scope.headSha}`);
  const intent = intentFromStageCommit(commit);
  if (
    intent.repository !== scope.repository ||
    intent.targetBranch !== scope.targetBranch ||
    intent.baseSha !== scope.baseSha ||
    intent.prNumber === scope.prNumber ||
    transferStageRef(intent, runId) !== ref
  ) {
    throw new CliError("Staged transfer scope does not match the original intent.", 75);
  }
  verifyStageCommit(intent, scope.headSha, commit);
  await verifyIntentObjects(reader, intent);
  if (
    mergeTree(scope, await reader.get(`${prefix}/git/commits/${scope.mergeSha}`)) !== intent.treeSha
  ) {
    throw new CliError("Staged PR merge tree differs from the authorized intent.", 75);
  }
  const statuses = await reader.get(`${prefix}/commits/${scope.headSha}/status`);
  const proof = latestAttestedStatus(statuses, {
    repository: scope.repository,
    sha: scope.headSha,
    context: transferPreparationContext,
  });
  const createdAt = Date.parse(getJsonString(proof, "created_at"));
  if (
    proof?.state !== "success" ||
    originalStatusDescription(proof) !== transferIntentDescription(intent) ||
    getJsonString(proof, "target_url") !== runUrl ||
    statusRunAttempt(proof) !== 1 ||
    !Number.isFinite(createdAt)
  ) {
    throw new CliError(
      "Missing signed preparation proof from the current authorized transfer.",
      75
    );
  }
  return { intent, createdAt, statuses };
}

/** The sole writer of the reserved staging namespace. No managed branch ref is updated. */
export async function createStagedTransfer(
  reader: JsonReader,
  write: Writer,
  publish: Publish,
  intent: TransferIntent,
  title: string,
  runId: number,
  assertCurrent: () => Promise<void>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<{ scope: PrCiScope; ref: string }> {
  await verifyIntentObjects(reader, intent);
  await assertCurrent();
  const prefix = `repos/${intent.repository}`;
  const ref = transferStageRef(intent, runId);
  const refPath = `${prefix}/git/ref/heads/${ref}`;
  if (await getGithubJsonIfExists(refPath, (path) => reader.get(path))) {
    throw new CliError("Transfer staging ref already exists; never overwrite a prior run.", 75);
  }
  const commit = await write("POST", `${prefix}/git/commits`, {
    message: transferStageMessage(intent),
    tree: intent.treeSha,
    parents: [intent.baseSha],
  });
  const sha = getJsonString(commit, "sha");
  if (!shaPattern.test(sha)) throw new CliError("No staging commit was returned.", 75);
  verifyStageCommit(intent, sha, commit);
  await assertCurrent();
  await write("POST", `${prefix}/git/refs`, { ref: `refs/heads/${ref}`, sha });
  await publish(sha, transferPreparationContext, "success", transferIntentDescription(intent));
  let prNumber = 0;
  try {
    const pull = await write("POST", `${prefix}/pulls`, {
      title,
      head: ref,
      base: intent.targetBranch,
      body: `Authorized transfer from original PR #${intent.prNumber}. Controller run ${runId}. Dedicated staging; ordinary governance cannot merge this branch.`,
    });
    prNumber = getJsonNumber(pull, "number");
    if (
      !Number.isSafeInteger(prNumber) ||
      prNumber < 1 ||
      !isStagedTransferDirection(pull, intent.repository) ||
      !isJsonRecord(pull) ||
      getJsonString(pull.head, "sha") !== sha
    ) {
      throw new CliError("Staged PR creation did not return the expected identity.", 75);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const scope = await readCurrentStagedTransferScope(
        reader,
        intent.repository,
        prNumber,
        sha,
        ref
      );
      if (scope) {
        if (
          scope.baseSha !== intent.baseSha ||
          mergeTree(scope, await reader.get(`${prefix}/git/commits/${scope.mergeSha}`)) !==
            intent.treeSha
        ) {
          throw new CliError("Staged PR snapshot changed during creation.", 75);
        }
        await assertCurrent();
        return { scope, ref };
      }
      if (attempt < 9) await wait(2000);
    }
    throw new CliError("Staged PR merge snapshot is not ready.", 75);
  } catch (error) {
    // Close only a positively identified staging PR. Never mutate either managed ref.
    if (prNumber > 0) {
      const pull = await reader.get(`${prefix}/pulls/${prNumber}`);
      if (
        isJsonRecord(pull) &&
        pull.state === "open" &&
        getJsonString(pull.head, "ref") === ref &&
        getJsonString(pull.head, "sha") === sha &&
        isStagedTransferDirection(pull, intent.repository)
      ) {
        await write("PATCH", `${prefix}/pulls/${prNumber}`, { state: "closed" });
      }
    }
    throw error;
  }
}

/** Close the logical source PR only if its locked source is still current after the staged merge. */
export async function closeOriginalTransfer(
  reader: JsonReader,
  write: Writer,
  intent: TransferIntent,
  mergedSha: string
): Promise<void> {
  const prefix = `repos/${intent.repository}`;
  const pull = await reader.get(`${prefix}/pulls/${intent.prNumber}`);
  const target = await reader.get(`${prefix}/branches/${intent.targetBranch}`);
  if (
    isJsonRecord(pull) &&
    pull.state === "open" &&
    isManagedTransferDirection(pull, intent.repository) &&
    getJsonString(pull.head, "sha") === intent.sourceSha &&
    getJsonString(pull.base, "ref") === intent.targetBranch &&
    isJsonRecord(target) &&
    getJsonString(target.commit, "sha") === mergedSha
  ) {
    await write("PATCH", `${prefix}/pulls/${intent.prNumber}`, { state: "closed" });
  }
}

/** Close only this run's unused staging PR. The source PR and protected refs remain untouched. */
export async function closeUnusedStagedTransfer(
  reader: JsonReader,
  write: Writer,
  repository: string,
  prNumber: number,
  headSha: string,
  ref: string,
  runId: number,
  runUrl: string
): Promise<void> {
  const prefix = `repos/${repository}`;
  const pull = await reader.get(`${prefix}/pulls/${prNumber}`);
  if (
    !isJsonRecord(pull) ||
    pull.number !== prNumber ||
    !isStagedTransferDirection(pull, repository) ||
    getJsonString(pull.head, "sha") !== headSha ||
    getJsonString(pull.head, "ref") !== ref
  ) {
    throw new CliError("Refusing cleanup of a different staging PR.", 75);
  }
  if (pull.state === "closed") return;
  if (pull.state !== "open") throw new CliError("Invalid staged PR state.", 75);
  const commit = await reader.get(`${prefix}/git/commits/${headSha}`);
  const intent = intentFromStageCommit(commit);
  if (
    intent.repository !== repository ||
    intent.targetBranch !== getJsonString(pull.base, "ref") ||
    transferStageRef(intent, runId) !== ref
  ) {
    throw new CliError("Refusing cleanup outside the current staging intent.", 75);
  }
  verifyStageCommit(intent, headSha, commit);
  const statuses = await reader.get(`${prefix}/commits/${headSha}/status`);
  const proof = latestAttestedStatus(statuses, {
    repository,
    sha: headSha,
    context: transferPreparationContext,
  });
  if (
    proof?.state !== "success" ||
    originalStatusDescription(proof) !== transferIntentDescription(intent) ||
    statusRunAttempt(proof) !== 1 ||
    getJsonString(proof, "target_url") !== runUrl
  ) {
    throw new CliError("Refusing cleanup of an unsigned staging PR.", 75);
  }
  await write("PATCH", `${prefix}/pulls/${prNumber}`, { state: "closed" });
}
