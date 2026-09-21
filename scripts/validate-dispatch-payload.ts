import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

const requiredKeys = ["schema_version", "request_id", "project", "bootstrap_ref", "repository"] as const;

export function validateDispatch(value: unknown): void {
  if (!isJsonRecord(value)) {
    throw new CliError("::error::client_payload must be a JSON object.", 64);
  }
  const missing = requiredKeys.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new CliError(`::error::Missing required fields: ${missing.join(", ")}.`, 64);
  }
  const invalid = requiredKeys.filter((key) => typeof value[key] !== "string");
  if (invalid.length > 0) {
    throw new CliError(`::error::Fields must be strings: ${invalid.join(", ")}.`, 64);
  }
  const empty = requiredKeys.filter((key) => value[key] === "");
  if (empty.length > 0) {
    throw new CliError(`::error::Fields cannot be empty: ${empty.join(", ")}.`, 64);
  }
  if (value.schema_version !== "1") {
    throw new CliError(`::error::Unsupported schema_version=${String(value.schema_version)}; only version 1 is supported.`, 65);
  }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(value.request_id))) {
    throw new CliError("::error::request_id has an invalid format.", 64);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(value.project))) {
    throw new CliError("::error::project has an invalid format.", 64);
  }
  if (!/^[0-9a-fA-F]{40}$/.test(String(value.bootstrap_ref))) {
    throw new CliError("::error::bootstrap_ref must be a full 40-character commit SHA.", 64);
  }
  const unknown = Object.keys(value).filter((key) => !requiredKeys.includes(key as typeof requiredKeys[number]));
  if (unknown.length > 0) {
    throw new CliError(`::error::Unsupported fields: ${unknown.join(", ")}.`, 64);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new CliError("::error::Pass the repository_dispatch client_payload JSON.", 64);
  }
  const value = parseJson(args[0] ?? "", "::error::client_payload is not valid JSON.", 64);
  validateDispatch(value);
  const payload = value as Record<string, unknown>;
  await appendLines(process.env.GITHUB_OUTPUT, [
    `schema_version=${String(payload.schema_version)}`,
    `request_id=${String(payload.request_id)}`,
    `project=${String(payload.project)}`,
    `bootstrap_ref=${String(payload.bootstrap_ref)}`,
    `repository=${String(payload.repository)}`,
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
