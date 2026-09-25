import { resolve, sep } from "node:path";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
} from "./runtime-command.ts";

type RuntimeJob = {
  job_id: string;
  instance_id: string;
  runner_profile: string;
  runner_backend: string;
  trust_domain: string;
  runner_labels_json: string;
  command_json: string;
  working_directory: string;
  timeout_minutes: number;
  capability_requests_json: string;
  artifacts_json: string;
  matrix_json: string;
};

const runtimeKeys = [
  "job_id",
  "instance_id",
  "runner_profile",
  "runner_backend",
  "trust_domain",
  "runner_labels_json",
  "command_json",
  "working_directory",
  "timeout_minutes",
  "capability_requests_json",
  "artifacts_json",
  "matrix_json",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRuntimeJob(value: unknown): RuntimeJob {
  if (!isRecord(value)) throw new CliError("Execution job payload must be an object.", 65);
  const keys = Object.keys(value).sort();
  const expected = [...runtimeKeys].sort();
  if (keys.length !== expected.length || keys.some((item, index) => item !== expected[index])) {
    throw new CliError("Execution job payload has unexpected fields.", 65);
  }
  for (const key of runtimeKeys) {
    if (key === "timeout_minutes") continue;
    if (typeof value[key] !== "string") {
      throw new CliError(`Execution job field must be a string: ${key}.`, 65);
    }
  }
  if (!Number.isInteger(value.timeout_minutes)
    || Number(value.timeout_minutes) < 1
    || Number(value.timeout_minutes) > 360
  ) {
    throw new CliError("Execution job timeout is invalid.", 65);
  }
  return value as unknown as RuntimeJob;
}

function confinedPath(root: string, relativePath: string): string {
  const base = resolve(root);
  const target = resolve(base, relativePath || ".");
  if (target !== base && !target.startsWith(base + sep)) {
    throw new CliError("Execution working directory escapes target root.", 77);
  }
  return target;
}

export function substituteExecutionTokens(
  value: string,
  paths: { target_root: string; control_root: string; temp_root: string },
): string {
  const replacements: Record<string, string> = {
    "{target_root}": paths.target_root,
    "{control_root}": paths.control_root,
    "{temp_root}": paths.temp_root,
  };
  let rendered = value;
  for (const [token, replacement] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(replacement);
  }
  if (/\{[a-z][a-z0-9_.-]*\}/.test(rendered)) {
    throw new CliError(`Execution command contains an unresolved token: ${value}.`, 65);
  }
  return rendered;
}

export async function executePlannedJob(
  value: unknown,
  paths: { target_root: string; control_root: string; temp_root: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const job = exactRuntimeJob(value);
  const commandValue = parseJson(job.command_json, "Execution command JSON is invalid.", 65);
  if (!Array.isArray(commandValue)
    || commandValue.length < 1
    || !commandValue.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new CliError("Execution command JSON must be a non-empty string array.", 65);
  }
  const command = commandValue.map((item) => substituteExecutionTokens(item, paths));
  const cwd = job.working_directory
    ? confinedPath(paths.target_root, substituteExecutionTokens(job.working_directory, paths))
    : resolve(paths.target_root);

  try {
    await runCommand(command[0]!, command.slice(1), {
      cwd,
      env,
      timeoutMs: job.timeout_minutes * 60 * 1000,
    });
  } catch (error) {
    if (env.EXECUTION_TARGET_PRIVATE === "true") {
      throw new CliError(
        `Execution job failed for private repository: ${job.instance_id}. Detailed command output is suppressed.`,
        error instanceof CliError ? error.exitCode : 1,
      );
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const raw = process.env.EXECUTION_JOB_JSON ?? "";
  const targetRoot = process.env.EXECUTION_TARGET_ROOT ?? "";
  const controlRoot = process.env.EXECUTION_CONTROL_ROOT ?? "";
  const tempRoot = process.env.EXECUTION_TEMP_ROOT ?? process.env.RUNNER_TEMP ?? "";
  if (!raw || !targetRoot || !controlRoot || !tempRoot) {
    throw new CliError(
      "EXECUTION_JOB_JSON, EXECUTION_TARGET_ROOT, EXECUTION_CONTROL_ROOT, and EXECUTION_TEMP_ROOT are required.",
      64,
    );
  }
  await executePlannedJob(
    parseJson(raw, "Execution job payload is not valid JSON.", 64),
    {
      target_root: targetRoot,
      control_root: controlRoot,
      temp_root: tempRoot,
    },
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
