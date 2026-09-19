import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

export function retryLines(value: unknown): string[] {
  if (!isJsonRecord(value) || !isJsonRecord(value.retry_report) || value.retry_report.schema_version !== "ocr.llm-retry-report/v1") {
    return [];
  }
  const report = value.retry_report;
  const lines = [`OCR retry summary: total_requests=${numberValue(report.total_requests)} retried_requests=${numberValue(report.retried_requests)} total_retries=${numberValue(report.total_retries)} recovered_requests=${numberValue(report.recovered_requests)} failed_requests=${numberValue(report.failed_requests)} cancelled_requests=${numberValue(report.cancelled_requests)}`];
  const requests = Array.isArray(report.requests) ? report.requests : [];
  for (const request of requests.filter(isJsonRecord)) {
    const attempts = Array.isArray(request.attempts) ? request.attempts : [];
    for (const attempt of attempts.filter(isJsonRecord).filter((item) => item.outcome === "error")) {
      lines.push(`OCR retry attempt: model=${stringValue(request.model)} file=${stringValue(request.file_path)} task=${stringValue(request.task_type)} request_no=${numberValue(request.request_no)} attempt=${numberValue(attempt.attempt)} status=${numberValue(attempt.status_code)} class=${stringValue(attempt.error_class)} phase=${stringValue(attempt.failure_phase)} retry_after_ms=${numberValue(attempt.retry_after_ms)} backoff_ms=${numberValue(attempt.observed_backoff_ms)} headers_ms=${numberValue(attempt.duration_to_headers_ms)}`);
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new CliError("Usage: report-ocr-retry.ts <ocr-result.json>", 64);
  }
  try {
    for (const line of retryLines(await readJson(args[0] ?? ""))) {
      console.error(line);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
