import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

export function shouldResume(value: unknown): boolean {
  if (!isJsonRecord(value) || value.status !== "failed" || typeof value.session_id !== "string" || !value.session_id) {
    return false;
  }
  const report = isJsonRecord(value.retry_report) ? value.retry_report : {};
  if (report.schema_version !== "ocr.llm-retry-report/v1") {
    return false;
  }
  const failed = (Array.isArray(report.requests) ? report.requests : [])
    .filter((request) => isJsonRecord(request) && request.outcome === "failed")
    .filter(isJsonRecord);
  return failed.length > 0 && failed.every((request) => {
    const attempts = Array.isArray(request.attempts) ? request.attempts.filter(isJsonRecord) : [];
    const last = attempts.at(-1);
    if (!last || last.outcome !== "error") {
      return false;
    }
    const status = typeof last.status_code === "number" ? last.status_code : 0;
    return ["timeout", "network", "overloaded"].includes(String(last.error_class)) || (status >= 500 && status <= 599);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new CliError("Usage: should-resume-ocr.ts <ocr-result.json>", 64);
  }
  try {
    if (!shouldResume(await readJson(args[0] ?? ""))) {
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      process.exit(1);
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
