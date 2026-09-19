import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

export function validateEvidence(value: unknown): void {
  if (
    !isJsonRecord(value)
    || typeof value.repository !== "string" || !value.repository
    || typeof value.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(value.head_sha)
    || typeof value.workflow !== "string" || !value.workflow
    || typeof value.gate_job !== "string" || !value.gate_job
    || typeof value.run_id !== "number"
    || !Array.isArray(value.jobs)
  ) {
    throw new CliError("::error::Invalid CI Evidence format.", 65);
  }
  if (value.gate_conclusion !== "success") {
    throw new CliError(`::error::Repository CI lacks a successful ${value.gate_job}: run=${value.run_id} conclusion=${String(value.gate_conclusion ?? "missing")}`, 1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new CliError("Usage: validate-ci-evidence.ts <evidence-json>", 64);
  }
  const path = args[0] ?? "";
  let value: unknown;
  try {
    value = await readJson(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`::error::Missing CI Evidence: ${path}`, 65);
    }
    throw error;
  }
  validateEvidence(value);
  const record = value as Record<string, unknown>;
  console.log(`CI evidence passed: run=${String(record.run_id)} gate=${String(record.gate_job)} workflow=${String(record.conclusion ?? "missing")}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
