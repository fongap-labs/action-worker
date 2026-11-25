import { isDeepStrictEqual } from "node:util";
import { isClosedDevProtection } from "./dev-bootstrap-authorization.ts";
import { assertTrustedDevWrite } from "./dev-write-guard.ts";
import { getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { CliError, handleError, isMain, readJson, runText } from "./runtime-command.ts";

type RulesetPayload = {
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: Record<string, unknown>;
  rules: unknown[];
};

/** GitHub Free organizations may reject native auto-merge on private repositories.
 * The separately attested Action Worker squash-merge path still provides
 * CI-green automatic merging without relaxing any existing status gates. */
export function settingMatchesPlatform(
  key: string,
  expected: unknown,
  actual: unknown,
  isPrivateRepository: boolean
): boolean {
  if (isDeepStrictEqual(actual, expected)) return true;
  return isPrivateRepository && key === "allow_auto_merge" && expected === true && actual === false;
}

export function settingsPayload(value: unknown): Record<string, unknown> {
  if (!isJsonRecord(value)) {
    throw new CliError("repository policy must be a JSON object", 2);
  }
  const { schema_version: _schema, ...payload } = value;
  return payload;
}

export function rulesetPayloads(value: unknown): RulesetPayload[] {
  if (!isJsonRecord(value) || value.schema_version !== 1 || !Array.isArray(value.rulesets)) {
    throw new CliError("ruleset policy must use schema_version 1 with a rulesets array", 2);
  }

  const names = new Set<string>();
  return value.rulesets.map((item) => {
    if (
      !isJsonRecord(item) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      typeof item.target !== "string" ||
      item.target.length === 0 ||
      typeof item.enforcement !== "string" ||
      item.enforcement.length === 0 ||
      !Array.isArray(item.bypass_actors) ||
      !isJsonRecord(item.conditions) ||
      !Array.isArray(item.rules)
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

export function rulesetsForRepository(
  rulesets: readonly RulesetPayload[],
  repository: string,
  controlRepository: string
): RulesetPayload[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) {
    throw new CliError("Trusted control repository is required for ruleset scoping.", 2);
  }
  return rulesets.map((ruleset) => {
    // Business statuses are written by fongap-bot (App 5609149). The control
    // repository's self-CI emits the same check from GitHub Actions (App 15368).
    if (repository !== controlRepository || ruleset.name !== "Protect Main Branch") {
      return ruleset;
    }
    return {
      ...ruleset,
      rules: ruleset.rules.map((rule) => {
        if (!isJsonRecord(rule) || rule.type !== "required_status_checks") return rule;
        if (!isJsonRecord(rule.parameters)) {
          throw new CliError("Required check ruleset parameters are invalid.", 2);
        }
        return {
          ...rule,
          parameters: {
            ...rule.parameters,
            required_status_checks: [{ context: "validate-merge", integration_id: 15368 }],
          },
        };
      }),
    };
  });
}

/** Keep the default closed policy intact. Only explicit repository enrollment derives a dev gate. */
export function managedRepositoryRulesets(
  policy: unknown,
  repository: string,
  controlRepository: string
): RulesetPayload[] {
  const rulesets = rulesetPayloads(policy);
  const closed = rulesets.find((rule) => rule.name === "Protect Dev Branch");
  if (!closed || !isClosedDevProtection(closed)) {
    throw new CliError("Default dev protection must remain closed.", 65);
  }
  const enrolled = isJsonRecord(policy) ? policy.dev_merge_repositories : undefined;
  if (
    !Array.isArray(enrolled) ||
    enrolled.some(
      (name) =>
        typeof name !== "string" ||
        !/^fongap-labs\/[A-Za-z0-9_.-]+$/.test(name) ||
        name === controlRepository
    ) ||
    new Set(enrolled).size !== enrolled.length
  ) {
    throw new CliError("Invalid development repository enrollment.", 65);
  }
  const scoped = rulesetsForRepository(rulesets, repository, controlRepository);
  if (!enrolled.includes(repository)) return scoped;
  const main = scoped.find((rule) => rule.name === "Protect Main Branch");
  if (!main) throw new CliError("Main protection template is missing.", 65);
  return scoped.map((rule) => {
    if (rule.name !== "Protect Dev Branch") return rule;
    return {
      ...main,
      name: rule.name,
      conditions: rule.conditions,
      rules: [
        { type: "creation" },
        ...main.rules.map((item) => {
          if (!isJsonRecord(item) || item.type !== "required_status_checks") return item;
          if (!isJsonRecord(item.parameters)) {
            throw new CliError("Main protection check template is invalid.", 65);
          }
          return {
            ...item,
            parameters: {
              ...item.parameters,
              required_status_checks: [{ context: "validate-merge-dev", integration_id: 5609149 }],
            },
          };
        }),
      ],
    };
  });
}

async function requireInitializedDev(
  repository: string,
  controlRepository: string,
  token: string
): Promise<void> {
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    token,
    token
  );
  const metadata = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(metadata) ||
    metadata.full_name !== repository ||
    metadata.private !== false ||
    metadata.default_branch !== "main"
  ) {
    throw new CliError("Development enrollment requires a public managed main repository.", 75);
  }
  const branch = await reader.get(`repos/${repository}/branches/dev`);
  const sha = isJsonRecord(branch) ? getJsonString(branch.commit, "sha") : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new CliError("Development enrollment requires an initialized dev branch.", 75);
  }
  await assertTrustedDevWrite(reader, repository, sha, controlRepository);
}

function rulesetSnapshot(value: unknown): RulesetPayload {
  if (!isJsonRecord(value)) {
    throw new CliError("repository ruleset response is invalid");
  }
  return rulesetPayloads({
    schema_version: 1,
    rulesets: [
      {
        name: value.name,
        target: value.target,
        enforcement: value.enforcement,
        bypass_actors: value.bypass_actors ?? [],
        conditions: value.conditions,
        rules: value.rules,
      },
    ],
  })[0]!;
}

async function ghJson(
  method: "GET" | "POST" | "PUT" | "PATCH",
  endpoint: string,
  token: string,
  input?: unknown
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
  return output ? (JSON.parse(output) as unknown) : {};
}

async function applyRulesets(
  repository: string,
  token: string,
  isPrivate: boolean,
  rulesets: readonly RulesetPayload[]
): Promise<void> {
  if (isPrivate) {
    console.warn(
      `::warning::Managed branch protection is NOT enforced for private repository ${repository}: GitHub Free organization rulesets are unavailable. The post-merge audit cannot prevent a merge. Upgrade the GitHub plan to enable enforceable required checks.`
    );
    return;
  }

  const existingValue = await ghJson(
    "GET",
    `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
    token
  );
  if (!Array.isArray(existingValue)) {
    throw new CliError("repository ruleset list response is invalid");
  }

  const existingByName = new Map<string, number>();
  for (const item of existingValue) {
    if (
      !isJsonRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.id !== "number" ||
      !Number.isInteger(item.id)
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
      await ghJson("GET", `repos/${repository}/rulesets/${id}?includes_parents=false`, token)
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
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "fongap-labs/action-worker";
  try {
    payload = settingsPayload(await readJson(policyPath));
    rulesets = managedRepositoryRulesets(
      await readJson(rulesetPolicyPath),
      repository,
      controlRepository
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(
        `repository policy not found: ${String((error as NodeJS.ErrnoException).path ?? "")}`,
        2
      );
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

  const dev = rulesets.find((rule) => rule.name === "Protect Dev Branch");
  if (!isClosedDevProtection(dev)) {
    await requireInitializedDev(repository, controlRepository, token);
  }
  const response = await ghJson("PATCH", `repos/${repository}`, token, payload);
  if (!isJsonRecord(response)) {
    throw new CliError("repository settings response is invalid");
  }
  for (const [key, expected] of Object.entries(payload)) {
    if (!settingMatchesPlatform(key, expected, response[key], response.private === true)) {
      throw new CliError(
        `repository setting mismatch: ${key} expected=${JSON.stringify(expected)} actual=${JSON.stringify(response[key])}`
      );
    }
    if (response.private === true && key === "allow_auto_merge" && response[key] === false) {
      console.warn(
        `::notice::${repository} cannot enable native auto-merge on this GitHub plan; signed CI-green Action Worker merging remains active.`
      );
    }
  }

  await applyRulesets(repository, token, response.private === true, rulesets);
  console.log(`repository settings applied: ${repository}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
