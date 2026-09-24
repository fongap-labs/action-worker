import { isDeepStrictEqual } from "node:util";
import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

type JsonRecord = Record<string, unknown>;

export function rulesetPayload(value: unknown): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new CliError("main branch ruleset policy must be a JSON object", 2);
  }
  const { schema_version: _schema, repositories: _repositories, ...payload } = value;
  return payload;
}

export function managedRepositories(value: unknown): string[] {
  if (!isJsonRecord(value) || !Array.isArray(value.repositories)) {
    throw new CliError("main branch ruleset repositories are required", 2);
  }
  const repositories = value.repositories.filter(
    (item): item is string => typeof item === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item),
  );
  if (repositories.length !== value.repositories.length || new Set(repositories).size !== repositories.length) {
    throw new CliError("main branch ruleset repositories are invalid", 2);
  }
  return repositories;
}

function normalizeRules(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((rule) => {
    if (!isJsonRecord(rule) || rule.type !== "required_status_checks" || !isJsonRecord(rule.parameters)) {
      return rule;
    }
    const checks = Array.isArray(rule.parameters.required_status_checks)
      ? rule.parameters.required_status_checks.map((check) => {
          if (!isJsonRecord(check)) {
            return check;
          }
          const normalized: JsonRecord = { context: check.context };
          if (typeof check.integration_id === "number") {
            normalized.integration_id = check.integration_id;
          }
          return normalized;
        })
      : rule.parameters.required_status_checks;
    return {
      ...rule,
      parameters: {
        ...rule.parameters,
        required_status_checks: checks,
      },
    };
  });
}

async function ghJson(args: string[], token: string, input?: unknown): Promise<unknown> {
  const output = await runText("gh", ["api", ...args], {
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, GH_TOKEN: token },
  });
  return JSON.parse(output) as unknown;
}

async function main(): Promise<void> {
  const repository = process.argv[2] ?? "";
  const dryValue = process.argv[3] ?? "false";
  const policyPath = process.env.MAIN_BRANCH_RULESET_POLICY ?? "policies/main-branch-ruleset.json";

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError("repository must use owner/name format", 2);
  }
  if (dryValue !== "true" && dryValue !== "false") {
    throw new CliError("is_dry_run must be true or false", 2);
  }

  const policy = await readJson(policyPath);
  const repositories = managedRepositories(policy);
  if (!repositories.includes(repository)) {
    throw new CliError(`repository is not managed by main branch ruleset policy: ${repository}`, 2);
  }
  const payload = rulesetPayload(policy);

  if (dryValue === "true") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("GH_TOKEN is required", 2);
  }

  const list = await ghJson([`repos/${repository}/rulesets`], token);
  if (!Array.isArray(list)) {
    throw new CliError("ruleset list response is invalid");
  }

  const name = String(payload.name ?? "");
  const matches = list.filter((item) => isJsonRecord(item) && item.name === name);
  if (matches.length > 1) {
    throw new CliError(`multiple rulesets named ${name} found in ${repository}`);
  }

  let rulesetId = 0;
  if (matches.length === 1) {
    const id = isJsonRecord(matches[0]) ? matches[0].id : undefined;
    rulesetId = typeof id === "number" ? id : 0;
    if (!rulesetId) {
      throw new CliError("managed ruleset id is invalid");
    }
    await ghJson([
      "--method", "PUT",
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28",
      `repos/${repository}/rulesets/${rulesetId}`,
      "--input", "-",
    ], token, payload);
  } else {
    const created = await ghJson([
      "--method", "POST",
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28",
      `repos/${repository}/rulesets`,
      "--input", "-",
    ], token, payload);
    rulesetId = isJsonRecord(created) && typeof created.id === "number" ? created.id : 0;
    if (!rulesetId) {
      throw new CliError("created ruleset id is invalid");
    }
  }

  const actual = await ghJson([`repos/${repository}/rulesets/${rulesetId}`], token);
  if (!isJsonRecord(actual)) {
    throw new CliError("ruleset verification response is invalid");
  }

  for (const key of ["name", "target", "enforcement", "conditions"] as const) {
    if (!isDeepStrictEqual(actual[key], payload[key])) {
      throw new CliError(
        `ruleset mismatch: ${key} expected=${JSON.stringify(payload[key])} actual=${JSON.stringify(actual[key])}`,
      );
    }
  }
  if (!isDeepStrictEqual(normalizeRules(actual.rules), normalizeRules(payload.rules))) {
    throw new CliError(
      `ruleset mismatch: rules expected=${JSON.stringify(payload.rules)} actual=${JSON.stringify(actual.rules)}`,
    );
  }

  console.log(`main branch ruleset applied: ${repository}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
