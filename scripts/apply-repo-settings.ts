import { isDeepStrictEqual } from "node:util";
import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

export function settingsPayload(value: unknown): Record<string, unknown> {
  if (!isJsonRecord(value)) {
    throw new CliError("repository policy must be a JSON object", 2);
  }
  const { schema_version: _schema, ...payload } = value;
  return payload;
}

async function main(): Promise<void> {
  const repository = process.argv[2] ?? "";
  const dryValue = process.argv[3] ?? "false";
  const policyPath = process.env.REPOSITORY_POLICY ?? "policies/repository.json";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError("repository must use owner/name format", 2);
  }
  if (dryValue !== "true" && dryValue !== "false") {
    throw new CliError("is_dry_run must be true or false", 2);
  }
  let payload: Record<string, unknown>;
  try {
    payload = settingsPayload(await readJson(policyPath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`repository policy not found: ${policyPath}`, 2);
    }
    throw error;
  }
  if (dryValue === "true") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("GH_TOKEN is required", 2);
  }
  const output = await runText("gh", [
    "api",
    "--method",
    "PATCH",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    `repos/${repository}`,
    "--input",
    "-",
  ], { input: JSON.stringify(payload), env: { ...process.env, GH_TOKEN: token } });
  const response = JSON.parse(output) as unknown;
  if (!isJsonRecord(response)) {
    throw new CliError("repository settings response is invalid");
  }
  for (const [key, expected] of Object.entries(payload)) {
    if (!isDeepStrictEqual(response[key], expected)) {
      throw new CliError(`repository setting mismatch: ${key} expected=${JSON.stringify(expected)} actual=${JSON.stringify(response[key])}`);
    }
  }
  console.log(`repository settings applied: ${repository}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
