import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const CANARY_SCHEMA = "1";
const TARGET = "scripts/task-transfer-envelope.ts";
const ATTACK_TEXT = "// CANARY_UNTRUSTED_WORKSPACE_MUTATION_DO_NOT_EXECUTE";
const PAYLOAD = "synthetic-task-result";
const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("Isolation canary input is invalid.", 66);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new CliError("Isolation canary rejects unknown artifact fields.", 66);
  }
}

function runIdentity(runId: string, attempt: string): void {
  if (!/^[1-9][0-9]{0,18}$/.test(runId) || !/^[1-9][0-9]{0,5}$/.test(attempt)) {
    throw new CliError("Isolation canary run identity is invalid.", 66);
  }
}

export type CanaryPreparation = {
  schema: "1";
  run_id: string;
  attempt: string;
  trusted_sha256: string;
  fixture_sha256: string;
};

export type CanaryResult = {
  schema: "1";
  run_id: string;
  attempt: string;
  fixture_sha256: string;
  workspace_modified: true;
  background_attempted: true;
  result: string;
};

export function parsePreparation(input: unknown, runId: string, attempt: string): CanaryPreparation {
  runIdentity(runId, attempt);
  const data = record(input);
  exact(data, ["schema", "run_id", "attempt", "trusted_sha256", "fixture_sha256"]);
  if (
    data.schema !== CANARY_SCHEMA ||
    data.run_id !== runId ||
    data.attempt !== attempt ||
    typeof data.trusted_sha256 !== "string" ||
    typeof data.fixture_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.trusted_sha256) ||
    !/^[a-f0-9]{64}$/.test(data.fixture_sha256)
  ) throw new CliError("Isolation canary preparation failed identity validation.", 66);
  return data as CanaryPreparation;
}

export function validateResult(input: unknown, preparation: CanaryPreparation): CanaryResult {
  const data = record(input);
  exact(data, [
    "schema", "run_id", "attempt", "fixture_sha256",
    "workspace_modified", "background_attempted", "result",
  ]);
  if (
    data.schema !== CANARY_SCHEMA ||
    data.run_id !== preparation.run_id ||
    data.attempt !== preparation.attempt ||
    data.fixture_sha256 !== preparation.fixture_sha256 ||
    data.workspace_modified !== true ||
    data.background_attempted !== true ||
    data.result !== PAYLOAD
  ) throw new CliError("Isolation canary result failed authentication of test context.", 66);
  return data as CanaryResult;
}

export async function prepareCanary(
  workspace: string,
  runId: string,
  attempt: string
): Promise<CanaryPreparation> {
  runIdentity(runId, attempt);
  const trusted = await readFile(join(workspace, TARGET));
  return {
    schema: "1",
    run_id: runId,
    attempt,
    trusted_sha256: sha(trusted),
    fixture_sha256: sha(PAYLOAD),
  };
}

export async function runUntrustedCanary(
  workspace: string,
  preparation: CanaryPreparation,
  runId: string,
  attempt: string
): Promise<CanaryResult> {
  const validated = parsePreparation(preparation, runId, attempt);
  const path = join(workspace, TARGET);
  const original = await readFile(path);
  if (sha(original) !== validated.trusted_sha256) {
    throw new CliError("Isolation canary trusted source mismatched before mutation.", 66);
  }
  // This simulates downstream code changing a trusted script in its own workspace.
  await writeFile(path, Buffer.concat([original, Buffer.from("\n" + ATTACK_TEXT + "\n")]));
  const changed = await readFile(path);
  if (!changed.toString("utf8").includes(ATTACK_TEXT)) {
    throw new CliError("Isolation canary did not mutate the task workspace.", 66);
  }
  return {
    schema: "1",
    run_id: validated.run_id,
    attempt: validated.attempt,
    fixture_sha256: validated.fixture_sha256,
    workspace_modified: true,
    background_attempted: true,
    result: PAYLOAD,
  };
}

export async function finalizeCanary(
  workspace: string,
  preparation: CanaryPreparation,
  result: unknown,
  runId: string,
  attempt: string
): Promise<void> {
  const validated = parsePreparation(preparation, runId, attempt);
  validateResult(result, validated);
  const trusted = await readFile(join(workspace, TARGET));
  if (sha(trusted) !== validated.trusted_sha256 || trusted.toString("utf8").includes(ATTACK_TEXT)) {
    throw new CliError("Isolation canary detected poisoned trusted source.", 66);
  }
}

async function main(): Promise<void> {
  const [command = "", fileA = "", fileB = ""] = process.argv.slice(2);
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
  if (!fileA) throw new CliError("Isolation canary requires an explicit artifact path.", 64);
  if (command === "prepare") {
    await writeFile(fileA, JSON.stringify(await prepareCanary(workspace, runId, attempt)));
  } else if (command === "execute") {
    if (!fileB) throw new CliError("Isolation canary requires an output path.", 64);
    const prep = JSON.parse(await readFile(fileA, "utf8")) as unknown;
    await writeFile(
      fileB,
      JSON.stringify(
        await runUntrustedCanary(workspace, parsePreparation(prep, runId, attempt), runId, attempt)
      )
    );
  } else if (command === "finalize") {
    if (!fileB) throw new CliError("Isolation canary requires an output path.", 64);
    const prep = JSON.parse(await readFile(fileA, "utf8")) as unknown;
    const result = JSON.parse(await readFile(fileB, "utf8")) as unknown;
    await finalizeCanary(
      workspace,
      parsePreparation(prep, runId, attempt),
      result,
      runId,
      attempt
    );
    console.log("Runner isolation canary passed.");
  } else {
    throw new CliError("Usage: task-runner-isolation-canary.ts prepare|execute|finalize ...", 64);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
