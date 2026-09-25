import { readFile } from "node:fs/promises";
import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

export const executionOperations = [
  "ci",
  "review",
  "build",
  "release",
  "deploy",
  "task",
  "scheduled",
] as const;

export type ExecutionOperation = typeof executionOperations[number];

export type ExecutionRequest = {
  schema_version: "1";
  request_id: string;
  repository: string;
  source_sha: string;
  operation: ExecutionOperation;
};

export type ExecutionArtifact = {
  name: string;
  path: string;
  required?: boolean;
};

export type ExecutionJob = {
  id: string;
  runner_profile: string;
  command: string[];
  working_directory?: string;
  timeout_minutes: number;
  depends_on?: string[];
  capability_requests: string[];
  matrix?: Record<string, string[]>;
  artifacts?: ExecutionArtifact[];
};

export type ExecutionManifest = {
  schema_version: "1";
  operations: Partial<Record<ExecutionOperation, { jobs: ExecutionJob[] }>>;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const artifactNamePattern = /^[A-Za-z0-9._-]{1,128}$/;
const matrixKeyPattern = /^[a-z][a-z0-9_]*$/;
const operationSet = new Set<string>(executionOperations);

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new CliError(
      `Execution contract keys are invalid: missing=${missing.join(",") || "none"} unknown=${unknown.join(",") || "none"}.`,
      65,
    );
  }
}

function uniqueStrings(value: unknown, label: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new CliError(`${label} must be a string array.`, 65);
  }
  const items = value as string[];
  if (new Set(items).size !== items.length) {
    throw new CliError(`${label} must not contain duplicates.`, 65);
  }
  if (pattern && !items.every((item) => pattern.test(item))) {
    throw new CliError(`${label} contains an invalid value.`, 65);
  }
  return items;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  return !value.split(/[\\/]+/).includes("..");
}

export function parseExecutionRequest(value: unknown): ExecutionRequest {
  if (!isJsonRecord(value)) {
    throw new CliError("Execution Request must be a JSON object.", 65);
  }
  exactKeys(
    value,
    ["schema_version", "request_id", "repository", "source_sha", "operation"],
    ["schema_version", "request_id", "repository", "source_sha", "operation"],
  );
  if (value.schema_version !== "1"
    || typeof value.request_id !== "string" || !requestPattern.test(value.request_id)
    || typeof value.repository !== "string" || !repositoryPattern.test(value.repository)
    || typeof value.source_sha !== "string" || !shaPattern.test(value.source_sha)
    || typeof value.operation !== "string" || !operationSet.has(value.operation)
  ) {
    throw new CliError("Execution Request does not match contracts/execution-request.json.", 65);
  }
  return value as ExecutionRequest;
}

function parseArtifact(value: unknown): ExecutionArtifact {
  if (!isJsonRecord(value)) {
    throw new CliError("Execution artifact must be an object.", 65);
  }
  exactKeys(value, ["name", "path", "required"], ["name", "path"]);
  if (typeof value.name !== "string" || !artifactNamePattern.test(value.name)
    || typeof value.path !== "string" || value.path.length > 512 || !isSafeRelativePath(value.path)
    || (value.required !== undefined && typeof value.required !== "boolean")
  ) {
    throw new CliError("Execution artifact is invalid.", 65);
  }
  return {
    name: value.name,
    path: value.path,
    ...(value.required === undefined ? {} : { required: value.required }),
  };
}

function parseMatrix(value: unknown): Record<string, string[]> {
  if (!isJsonRecord(value) || Object.keys(value).length > 16) {
    throw new CliError("Execution matrix is invalid.", 65);
  }
  const result: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!matrixKeyPattern.test(key)) {
      throw new CliError(`Execution matrix key is invalid: ${key}.`, 65);
    }
    const values = uniqueStrings(raw, `matrix.${key}`);
    if (values.length < 1 || values.length > 32 || values.some((item) => item.length > 256)) {
      throw new CliError(`Execution matrix values are invalid: ${key}.`, 65);
    }
    result[key] = values;
  }
  return result;
}

function parseJob(value: unknown): ExecutionJob {
  if (!isJsonRecord(value)) {
    throw new CliError("Execution job must be an object.", 65);
  }
  exactKeys(
    value,
    [
      "id",
      "runner_profile",
      "command",
      "working_directory",
      "timeout_minutes",
      "depends_on",
      "capability_requests",
      "matrix",
      "artifacts",
    ],
    ["id", "runner_profile", "command", "timeout_minutes", "capability_requests"],
  );

  if (typeof value.id !== "string" || !idPattern.test(value.id)
    || typeof value.runner_profile !== "string" || !idPattern.test(value.runner_profile)
    || !Number.isInteger(value.timeout_minutes)
    || Number(value.timeout_minutes) < 1
    || Number(value.timeout_minutes) > 360
  ) {
    throw new CliError("Execution job identity, runner profile, or timeout is invalid.", 65);
  }

  const command = uniqueStrings(value.command, `job.${value.id}.command`);
  if (command.length > 64 || command.some((item) => item.length > 4096)) {
    throw new CliError(`Execution command is too large: ${value.id}.`, 65);
  }

  const workingDirectory = value.working_directory;
  if (workingDirectory !== undefined
    && (typeof workingDirectory !== "string" || workingDirectory.length > 512 || !isSafeRelativePath(workingDirectory))
  ) {
    throw new CliError(`Execution working directory is unsafe: ${value.id}.`, 65);
  }

  const dependsOn = value.depends_on === undefined
    ? []
    : uniqueStrings(value.depends_on, `job.${value.id}.depends_on`, idPattern);
  if (dependsOn.length > 32 || dependsOn.includes(value.id)) {
    throw new CliError(`Execution dependencies are invalid: ${value.id}.`, 65);
  }

  const capabilities = uniqueStrings(
    value.capability_requests,
    `job.${value.id}.capability_requests`,
    capabilityPattern,
  );
  if (capabilities.length > 32) {
    throw new CliError(`Execution capability request is too large: ${value.id}.`, 65);
  }

  const artifacts = value.artifacts === undefined
    ? []
    : (() => {
      if (!Array.isArray(value.artifacts) || value.artifacts.length > 32) {
        throw new CliError(`Execution artifacts are invalid: ${value.id}.`, 65);
      }
      const parsed = value.artifacts.map(parseArtifact);
      if (new Set(parsed.map((item) => item.name)).size !== parsed.length) {
        throw new CliError(`Execution artifact names must be unique: ${value.id}.`, 65);
      }
      return parsed;
    })();

  return {
    id: value.id,
    runner_profile: value.runner_profile,
    command,
    timeout_minutes: Number(value.timeout_minutes),
    capability_requests: capabilities,
    ...(workingDirectory === undefined ? {} : { working_directory: workingDirectory }),
    ...(dependsOn.length === 0 ? {} : { depends_on: dependsOn }),
    ...(value.matrix === undefined ? {} : { matrix: parseMatrix(value.matrix) }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
  };
}

function validateJobGraph(jobs: readonly ExecutionJob[]): void {
  const ids = jobs.map((job) => job.id);
  if (new Set(ids).size !== ids.length) {
    throw new CliError("Execution job ids must be unique within an operation.", 65);
  }
  const known = new Set(ids);
  for (const job of jobs) {
    for (const dependency of job.depends_on ?? []) {
      if (!known.has(dependency)) {
        throw new CliError(`Execution dependency does not exist: ${job.id} -> ${dependency}.`, 65);
      }
    }
  }

  const states = new Map<string, number>();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const visit = (id: string): void => {
    const state = states.get(id) ?? 0;
    if (state === 1) {
      throw new CliError(`Execution dependency cycle detected at job: ${id}.`, 65);
    }
    if (state === 2) return;
    states.set(id, 1);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    states.set(id, 2);
  };
  for (const id of ids) visit(id);
}

export function parseExecutionManifest(value: unknown): ExecutionManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Execution Manifest must be a JSON object.", 65);
  }
  exactKeys(value, ["schema_version", "operations"], ["schema_version", "operations"]);
  if (value.schema_version !== "1" || !isJsonRecord(value.operations)) {
    throw new CliError("Execution Manifest does not match contracts/execution-manifest.json.", 65);
  }

  const rawOperations = value.operations;
  const keys = Object.keys(rawOperations);
  if (keys.length === 0 || keys.some((key) => !operationSet.has(key))) {
    throw new CliError("Execution Manifest contains invalid operations.", 65);
  }

  const operations: ExecutionManifest["operations"] = {};
  for (const key of keys) {
    const raw = rawOperations[key];
    if (!isJsonRecord(raw)) {
      throw new CliError(`Execution operation must be an object: ${key}.`, 65);
    }
    exactKeys(raw, ["jobs"], ["jobs"]);
    if (!Array.isArray(raw.jobs) || raw.jobs.length < 1 || raw.jobs.length > 32) {
      throw new CliError(`Execution operation jobs are invalid: ${key}.`, 65);
    }
    const jobs = raw.jobs.map(parseJob);
    validateJobGraph(jobs);
    operations[key as ExecutionOperation] = { jobs };
  }

  return { schema_version: "1", operations };
}

export function jobsForOperation(
  manifest: ExecutionManifest,
  operation: ExecutionOperation,
): ExecutionJob[] {
  const entry = manifest.operations[operation];
  if (!entry) {
    throw new CliError(`Execution Manifest does not define operation: ${operation}.`, 65);
  }
  return entry.jobs;
}

async function main(): Promise<void> {
  const [command, input = "", operation = ""] = process.argv.slice(2);
  if (command === "request") {
    const request = parseExecutionRequest(parseJson(input, "Execution Request is not valid JSON.", 64));
    console.log(JSON.stringify(request));
    return;
  }
  if (command === "manifest") {
    if (!input) throw new CliError("Usage: execution-contract.ts manifest <path> [operation]", 64);
    const manifest = parseExecutionManifest(JSON.parse(await readFile(input, "utf8")) as unknown);
    if (operation) {
      if (!operationSet.has(operation)) throw new CliError(`Unknown operation: ${operation}.`, 64);
      console.log(JSON.stringify(jobsForOperation(manifest, operation as ExecutionOperation)));
      return;
    }
    console.log(JSON.stringify(manifest));
    return;
  }
  throw new CliError("Usage: execution-contract.ts <request|manifest> <input> [operation]", 64);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
