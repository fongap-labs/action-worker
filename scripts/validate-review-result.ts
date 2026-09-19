import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

export function validateReview(value: unknown): void {
  if (!isJsonRecord(value) || (value.comments !== undefined && !Array.isArray(value.comments))) {
    throw new CliError("ERROR: OpenCodeReview result is not a complete review: status=invalid terminal_state=invalid", 65);
  }
  const manifest = isJsonRecord(value.manifest) ? value.manifest : undefined;
  const terminal = manifest?.terminal_state;
  const isComplete = terminal !== undefined
    ? terminal === "complete"
    : value.status === "complete" || value.status === "success";
  if (!isComplete) {
    throw new CliError(`ERROR: OpenCodeReview result is not a complete review: status=${String(value.status ?? "missing")} terminal_state=${String(terminal ?? "missing")}`, 65);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new CliError("Usage: validate-review-result.ts <result-json>", 64);
  }
  const path = args[0] ?? "";
  try {
    validateReview(await readJson(path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`ERROR: OpenCodeReview result file does not exist: ${path}`, 65);
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
