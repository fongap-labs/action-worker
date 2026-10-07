import { getJsonArray, getJsonString, isJsonRecord, type JsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const defaultControlRepository = "fongap-labs/action-worker";

// Only these control workflows publish a successful "CI Evidence" status.
export const ciEvidenceWorkflowPaths: readonly string[] = [
  ".github/workflows/central-ci-dispatch.yml",
  ".github/workflows/handle-pr-dispatch.yml",
];

// The status is written by the run itself, so its creation time must fall inside the run window.
const runWindowSlackMs = 120_000;

export type JsonReader = { get(path: string): Promise<unknown> };

export type VerifiedCiEvidenceOptions = {
  controlRepository?: string;
  workflowPaths?: readonly string[];
  runAttempts?: number;
  statusAttempts?: number;
  retryDelayMs?: number;
};

export function trustedControlRunId(targetUrl: string, controlRepository: string): number | null {
  if (!repositoryPattern.test(controlRepository)) return null;
  const prefix = `https://github.com/${controlRepository}/actions/runs/`;
  if (!targetUrl.startsWith(prefix)) return null;
  const suffix = targetUrl.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  const runId = Number(suffix);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

export function latestCiStatus(response: unknown, context: string): JsonRecord | undefined {
  return getJsonArray(response, "statuses")
    .filter(isJsonRecord)
    .find((item) => getJsonString(item, "context") === context);
}

export function trustedCiStatus(
  response: unknown,
  context: string,
  controlRepository: string
): JsonRecord | undefined {
  const status = latestCiStatus(response, context);
  if (!status) return undefined;
  const targetUrl = getJsonString(status, "target_url");
  return trustedControlRunId(targetUrl, controlRepository) ? status : undefined;
}

export function hasTrustedSuccessfulCiEvidence(
  response: unknown,
  context: string,
  controlRepository: string
): boolean {
  return (
    getJsonString(trustedCiStatus(response, context, controlRepository), "state") === "success"
  );
}

function sleep(delayMs: number): Promise<void> {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /HTTP 404\b/.test(error.message);
}

function runInsideWindow(run: JsonRecord, createdAt: number): boolean {
  const startedAt = Date.parse(getJsonString(run, "run_started_at"));
  const updatedAt = Date.parse(getJsonString(run, "updated_at"));
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(updatedAt) &&
    createdAt >= startedAt - runWindowSlackMs &&
    createdAt <= updatedAt + runWindowSlackMs
  );
}

/**
 * A "CI Evidence" status is only a claim: any account that can write commit statuses can set a
 * target_url that merely starts with the control run prefix. Look the run up in the control
 * repository and require that it is a successful run of a workflow that publishes this status,
 * on the default branch, and that the status was written while that run was executing.
 */
export async function hasVerifiedCiEvidence(
  reader: JsonReader,
  response: unknown,
  options: VerifiedCiEvidenceOptions = {}
): Promise<boolean> {
  const controlRepository = options.controlRepository ?? defaultControlRepository;
  const workflowPaths = options.workflowPaths ?? ciEvidenceWorkflowPaths;
  const runAttempts = options.runAttempts ?? 12;
  const retryDelayMs = options.retryDelayMs ?? 5_000;

  const status = trustedCiStatus(response, "CI Evidence", controlRepository);
  if (!status || getJsonString(status, "state") !== "success") return false;
  const runId = trustedControlRunId(getJsonString(status, "target_url"), controlRepository);
  const createdAt = Date.parse(getJsonString(status, "created_at"));
  if (runId === null || !Number.isFinite(createdAt)) return false;

  for (let attempt = 0; attempt < runAttempts; attempt += 1) {
    let run: unknown;
    try {
      run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (
      !isJsonRecord(run) ||
      getJsonString(run.repository, "full_name") !== controlRepository ||
      !workflowPaths.includes(getJsonString(run, "path")) ||
      getJsonString(run, "head_branch") !== "main"
    ) {
      return false;
    }
    if (getJsonString(run, "status") === "completed") {
      return getJsonString(run, "conclusion") === "success" && runInsideWindow(run, createdAt);
    }
    // The status is published before the last steps of the run finish; wait for the verdict.
    if (attempt + 1 < runAttempts) await sleep(retryDelayMs);
  }
  return false;
}

/** Wait for a verified successful CI Evidence on a commit; fail closed when it never appears. */
export async function requireVerifiedCiEvidence(
  reader: JsonReader,
  repository: string,
  sha: string,
  options: VerifiedCiEvidenceOptions = {}
): Promise<void> {
  const statusAttempts = options.statusAttempts ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const controlRepository = options.controlRepository ?? defaultControlRepository;

  for (let attempt = 0; attempt < statusAttempts; attempt += 1) {
    const response = await reader.get(`repos/${repository}/commits/${sha}/status`);
    const latest = latestCiStatus(response, "CI Evidence");
    const state = getJsonString(latest, "state");
    if (state === "success") {
      if (await hasVerifiedCiEvidence(reader, response, options)) return;
      throw new CliError(
        "::error::CI Evidence was not produced by a successful Action Worker CI run.",
        65
      );
    }
    if (state === "failure" || state === "error") {
      throw new CliError("::error::Source SHA failed CI Evidence.", 65);
    }
    if (attempt + 1 < statusAttempts) await sleep(retryDelayMs);
  }
  throw new CliError(
    `::error::Source SHA has no successful Action Worker CI Evidence (control=${controlRepository}).`,
    65
  );
}
