import { isDeepStrictEqual } from "node:util";
import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

type RulesetPayload = {
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: Record<string, unknown>;
  rules: unknown[];
};

export function settingsPayload(value: unknown): Record<string, unknown> {
  if (!isJsonRecord(value)) {
    throw new CliError("repository policy must be a JSON object", 2);
  }
  const { schema_version: _schema, ...payload } = value;
  return payload;
}

export function rulesetPayloads(value: unknown): RulesetPayload[] {
  if (!isJsonRecord(value)
    || value.schema_version !== 1
    || !Array.isArray(value.rulesets)
  ) {
    throw new CliError("ruleset policy must use schema_version 1 with a rulesets array", 2);
  }

  const names = new Set<string>();
  return value.rulesets.map((item) => {
    if (!isJsonRecord(item)
      || typeof item.name !== "string" || item.name.length === 0
      || typeof item.target !== "string" || item.target.length === 0
      || typeof item.enforcement !== "string" || item.enforcement.length === 0
      || !Array.isArray(item.bypass_actors)
      || !isJsonRecord(item.conditions)
      || !Array.isArray(item.rules)
    ) {
      throw new CliError("ruleset policy contains an invalid ruleset", 2);
    }
    if (names.has(item.name)) {
      throw new CliError(`ruleset policy contains duplicate name: ${item.name}`, 2);
    }
    names.add(item.name);
    return {
      name: item.name,
      target: item.target,
      enforcement: item.enforcement,
      bypass_actors: item.bypass_actors,
      conditions: item.conditions,
      rules: item.rules,
    };
  });
}

function rulesetSnapshot(value: unknown): RulesetPayload {
  if (!isJsonRecord(value)) {
    throw new CliError("repository ruleset response is invalid");
  }
  return rulesetPayloads({
    schema_version: 1,
    rulesets: [{
      name: value.name,
      target: value.target,
      enforcement: value.enforcement,
      bypass_actors: value.bypass_actors ?? [],
      conditions: value.conditions,
      rules: value.rules,
    }],
  })[0]!;
}

async function ghJson(
  method: "GET" | "POST" | "PUT",
  endpoint: string,
  token: string,
  input?: unknown,
): Promise<unknown> {
  const args = [
    "api",
    "--method",
    method,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    endpoint,
  ];
  if (input !== undefined) {
    args.push("--input", "-");
  }
  const output = await runText("gh", args, {
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, GH_TOKEN: token },
  });
  return output ? JSON.parse(output) as unknown : {};
}

async function applyRulesets(
  repository: string,
  token: string,
  isPrivate: boolean,
  rulesets: readonly RulesetPayload[],
): Promise<void> {
  if (isPrivate) {
    console.log(`repository rulesets skipped for private repository under the current GitHub Free organization: ${repository}`);
    return;
  }

  const existingValue = await ghJson(
    "GET",
    `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
    token,
  );
  if (!Array.isArray(existingValue)) {
    throw new CliError("repository ruleset list response is invalid");
  }

  const existingByName = new Map<string, number>();
  for (const item of existingValue) {
    if (!isJsonRecord(item)
      || typeof item.name !== "string"
      || typeof item.id !== "number"
      || !Number.isInteger(item.id)
    ) {
      continue;
    }
    existingByName.set(item.name, item.id);
  }

  for (const desired of rulesets) {
    const id = existingByName.get(desired.name);
    if (id === undefined) {
      await ghJson("POST", `repos/${repository}/rulesets`, token, desired);
      console.log(`repository ruleset created: ${repository} / ${desired.name}`);
      continue;
    }

    const current = rulesetSnapshot(
      await ghJson("GET", `repos/${repository}/rulesets/${id}?includes_parents=false`, token),
    );
    if (isDeepStrictEqual(current, desired)) {
      console.log(`repository ruleset already current: ${repository} / ${desired.name}`);
      continue;
    }

    await ghJson("PUT", `repos/${repository}/rulesets/${id}`, token, desired);
    console.log(`repository ruleset updated: ${repository} / ${desired.name}`);
  }
}

async function main(): Promise<void> {
  const repository = process.argv[2] ?? "";
  const dryValue = process.argv[3] ?? "false";
  const policyPath = process.env.REPOSITORY_POLICY ?? "policies/repository.json";
  const rulesetPolicyPath = process.env.RULESET_POLICY ?? "policies/rulesets.json";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError("repository must use owner/name format", 2);
  }
  if (dryValue !== "true" && dryValue !== "false") {
    throw new CliError("is_dry_run must be true or false", 2);
  }

  let payload: Record<string, unknown>;
  let rulesets: RulesetPayload[];
  try {
    payload = settingsPayload(await readJson(policyPath));
    rulesets = rulesetPayloads(await readJson(rulesetPolicyPath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`repository policy not found: ${String((error as NodeJS.ErrnoException).path ?? "")}`, 2);
    }
    throw error;
  }

  if (dryValue === "true") {
    console.log(JSON.stringify({ repository: payload, rulesets }, null, 2));
    return;
  }

  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("GH_TOKEN is required", 2);
  }

  const response = await ghJson("PUT", `repos/${repository}`, token, payload);
  if (!isJsonRecord(response)) {
    throw new CliError("repository settings response is invalid");
  }
  for (const [key, expected] of Object.entries(payload)) {
    if (!isDeepStrictEqual(response[key], expected)) {
      throw new CliError(`repository setting mismatch: ${key} expected=${JSON.stringify(expected)} actual=${JSON.stringify(response[key])}`);
    }
  }

  await applyRulesets(repository, token, response.private === true, rulesets);
  console.log(`repository settings applied: ${repository}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
