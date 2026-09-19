import { join } from "node:path";
import { readJson } from "./runtime-command.ts";
import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
} from "./runtime-command.ts";

function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function isReserved(name: string): boolean {
  return /^(?:GITHUB_|RUNNER_|ACTIONS_)/.test(name) || name === "NODE_OPTIONS";
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  if (!runnerTemp) {
    throw new CliError("::error::RUNNER_TEMP is not set.");
  }
  let snapshot: unknown;
  try {
    snapshot = await readJson(join(runnerTemp, "action-worker-repository-vars.json"));
  } catch {
    throw new CliError("::error::Repository Variables snapshot is missing.");
  }
  if (!isJsonRecord(snapshot)) {
    throw new CliError("::error::Repository Variables snapshot is invalid.");
  }
  for (const name of Object.keys(snapshot).sort()) {
    if (isReserved(name)) {
      continue;
    }
    if (!(name in process.env)) {
      throw new CliError(`::error::Repository Variable missing from runtime environment: ${name}`);
    }
    if (process.env[name] !== valueText(snapshot[name])) {
      throw new CliError(`::error::Repository Variable runtime collision: ${name}`);
    }
  }
  console.log("Repository Variables runtime check passed.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
