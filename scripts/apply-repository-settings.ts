import { isDeepStrictEqual } from "node:util";
import { formalTagProtection, readBetaReleasePolicy } from "./beta-release-authorization.ts";
import type { JsonReader } from "./ci-evidence.ts";
import { isClosedDevProtection } from "./dev-bootstrap-authorization.ts";
import { hasVerifiedDevWriteGuard } from "./dev-write-guard.ts";
import {
  getGithubJsonIfExists,
  getJsonString,
  isJsonRecord,
  statusAwareReader,
} from "./github-api.ts";
import { findActiveIncidents } from "./main-write-incidents.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import {
  appendLines,
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

/** Derive the ordinary dev gate from one organization-wide policy, never a second repo list. */
export function managedRepositoryRulesets(
  policy: unknown,
  repository: string,
  controlRepository: string,
  isDevReady = true
): RulesetPayload[] {
  const rulesets = rulesetPayloads(policy);
  const closed = rulesets.find((rule) => rule.name === "Protect Dev Branch");
  if (!closed || !isClosedDevProtection(closed)) {
    throw new CliError("Default dev protection must remain closed.", 65);
  }
  const mode = isJsonRecord(policy) ? policy.dev_merge_mode : undefined;
  if (mode !== "automatic" && mode !== "closed") {
    throw new CliError("Invalid development enrollment mode.", 65);
  }
  const scoped = rulesetsForRepository(rulesets, repository, controlRepository);
  if (
    mode === "closed" ||
    !isDevReady ||
    repository === controlRepository ||
    !/^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    return scoped;
  }
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

/** Live trust, not a static enrollment list, determines whether protection may open to PRs. */
export async function isDevEnrollmentReady(
  reader: JsonReader,
  repository: string,
  controlRepository: string
): Promise<boolean> {
  if (repository === controlRepository) return false;
  const prefix = `repos/${repository}`;
  const metadata = await reader.get(prefix);
  if (!isJsonRecord(metadata) || metadata.full_name !== repository) {
    throw new CliError("Development enrollment repository identity is invalid.", 75);
  }
  if (metadata.private !== false || metadata.default_branch !== "main") return false;
  const branch = await getGithubJsonIfExists(`${prefix}/branches/dev`, (path) => reader.get(path));
  if (branch === undefined) return false;
  const sha = isJsonRecord(branch) ? getJsonString(branch.commit, "sha") : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new CliError("Development enrollment branch identity is invalid.", 75);
  }
  if ((await findActiveIncidents(reader, repository, "dev")).length > 0) return false;
  const statuses = await reader.get(`${prefix}/commits/${sha}/status`);
  if (!(await hasVerifiedDevWriteGuard(reader, repository, sha, statuses, controlRepository))) {
    return false;
  }
  const current = await reader.get(`${prefix}/branches/dev`);
  return isJsonRecord(current) && getJsonString(current.commit, "sha") === sha;
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
        bypass_actors: value.bypass_actors,
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

/** Only the explicit GitHub plan restriction permits an unenforceable private repository. */
export function isUnsupportedPrivateRuleset(error: unknown, isPrivate: boolean): boolean {
  return (
    isPrivate &&
    error instanceof CliError &&
    /Upgrade to GitHub (?:Pro|Team|Enterprise) or make this repository public to enable this feature\.?\s*\(HTTP 403\)/i.test(
      error.message
    )
  );
}

async function applyRulesets(
  repository: string,
  token: string,
  isPrivate: boolean,
  rulesets: readonly RulesetPayload[]
): Promise<{ hasDevChanged: boolean; protectionApplied: boolean }> {
  let existingValue: unknown;
  try {
    existingValue = await ghJson(
      "GET",
      `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
      token
    );
  } catch (error) {
    if (!isUnsupportedPrivateRuleset(error, isPrivate)) throw error;
    console.warn(
      `::warning::Managed branch protection is NOT enforced for ${repository}: GitHub plan does not support private repository rulesets. Post-merge audit cannot prevent a merge.`
    );
    return { hasDevChanged: false, protectionApplied: false };
  }
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

  let hasDevChanged = false;
  for (const desired of rulesets) {
    const opensDev = desired.name === "Protect Dev Branch" && !isClosedDevProtection(desired);
    const id = existingByName.get(desired.name);
    if (id === undefined) {
      await ghJson("POST", `repos/${repository}/rulesets`, token, desired);
      console.log(`repository ruleset created: ${repository} / ${desired.name}`);
      if (opensDev) hasDevChanged = true;
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
    if (opensDev) hasDevChanged = true;
  }
  return { hasDevChanged, protectionApplied: true };
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
  let rulesetPolicy: unknown;
  let rulesets: RulesetPayload[];
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "fongap-labs/action-worker";
  try {
    payload = settingsPayload(await readJson(policyPath));
    rulesetPolicy = await readJson(rulesetPolicyPath);
    rulesets = managedRepositoryRulesets(rulesetPolicy, repository, controlRepository);
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
    console.log(
      JSON.stringify({ repository: payload, rulesets, requires_live_dev_proof: true }, null, 2)
    );
    return;
  }

  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("GH_TOKEN is required", 2);
  }

  const repositoryPolicy: unknown = JSON.parse(readRepositoryPolicyText());
  validateRepositoryCapability(repository, repositoryPolicy, "pr");
  const dev = rulesets.find((rule) => rule.name === "Protect Dev Branch");
  if (!isClosedDevProtection(dev)) {
    const reader = statusAwareReader(
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      token,
      token
    );
    const ready = await isDevEnrollmentReady(reader, repository, controlRepository);
    rulesets = managedRepositoryRulesets(rulesetPolicy, repository, controlRepository, ready);
    console.log(`Development enrollment: ${repository} / ${ready ? "ready" : "closed"}`);
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

  if (response.private === false && response.default_branch === "main") {
    const formalTags = formalTagProtection(
      readBetaReleasePolicy(),
      repository,
      repositoryPolicy,
      controlRepository
    );
    if (formalTags) rulesets.push(formalTags);
  }
  const { hasDevChanged, protectionApplied } = await applyRulesets(
    repository,
    token,
    response.private === true,
    rulesets
  );
  await appendLines(process.env.GITHUB_OUTPUT, [
    `dev_protection_changed=${hasDevChanged}`,
    `branch_protection_applied=${protectionApplied}`,
  ]);
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    `- ${repository}: ${protectionApplied ? "managed rulesets applied" : "UNPROTECTED (GitHub plan restriction)"}`,
  ]);
  console.log(`repository settings applied: ${repository}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
