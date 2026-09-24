import { isDeepStrictEqual } from "node:util";
import {
  githubEnvironment,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type RulesetPolicy = {
  name: string;
  repositories: string[];
  required_status_checks: string[];
  strict_required_status_checks_policy: boolean;
  do_not_enforce_on_create: boolean;
};

function parsePolicy(value: unknown): RulesetPolicy {
  if (!isJsonRecord(value)) {
    throw new CliError("ruleset policy must be a JSON object", 2);
  }

  const name = typeof value.name === "string" ? value.name : "";
  const repositories = Array.isArray(value.repositories)
    ? value.repositories.filter((item): item is string => typeof item === "string")
    : [];
  const checks = Array.isArray(value.required_status_checks)
    ? value.required_status_checks.filter((item): item is string => typeof item === "string")
    : [];

  if (!name || repositories.length === 0 || checks.length === 0) {
    throw new CliError("ruleset policy is incomplete", 2);
  }

  if (
    typeof value.strict_required_status_checks_policy !== "boolean" ||
    typeof value.do_not_enforce_on_create !== "boolean"
  ) {
    throw new CliError("ruleset status-check policy must use boolean flags", 2);
  }

  return {
    name,
    repositories,
    required_status_checks: checks,
    strict_required_status_checks_policy: value.strict_required_status_checks_policy,
    do_not_enforce_on_create: value.do_not_enforce_on_create,
  };
}

function normalizeRequiredStatusRule(
  rule: unknown,
  policy: RulesetPolicy,
): unknown {
  if (!isJsonRecord(rule) || rule.type !== "required_status_checks") {
    return rule;
  }

  const parameters = isJsonRecord(rule.parameters) ? rule.parameters : {};
  return {
    ...rule,
    parameters: {
      ...parameters,
      required_status_checks: policy.required_status_checks.map((context) => ({ context })),
      strict_required_status_checks_policy: policy.strict_required_status_checks_policy,
      do_not_enforce_on_create: policy.do_not_enforce_on_create,
    },
  };
}

async function main(): Promise<void> {
  const repository = process.argv[2] ?? "";
  const dryValue = process.argv[3] ?? "false";
  const policyPath = process.env.RULESET_POLICY ?? "policies/ruleset.json";

  if (!repositoryPattern.test(repository)) {
    throw new CliError("repository must use owner/name format", 2);
  }
  if (dryValue !== "true" && dryValue !== "false") {
    throw new CliError("is_dry_run must be true or false", 2);
  }

  const policy = parsePolicy(await readJson(policyPath));
  if (!policy.repositories.includes(repository)) {
    console.log(`ruleset policy skipped: ${repository}`);
    return;
  }

  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("GH_TOKEN is required", 2);
  }

  const listRaw = await runGithubCli(["api", `repos/${repository}/rulesets`], token);
  const list = JSON.parse(listRaw) as unknown;
  if (!Array.isArray(list)) {
    throw new CliError("ruleset list response is invalid");
  }

  const summary = list.find(
    (item) =>
      isJsonRecord(item) &&
      item.name === policy.name &&
      item.source_type === "Repository",
  );
  if (!isJsonRecord(summary) || typeof summary.id !== "number") {
    throw new CliError(`ruleset not found: ${repository} / ${policy.name}`);
  }

  const fullRaw = await runGithubCli(
    ["api", `repos/${repository}/rulesets/${summary.id}`],
    token,
  );
  const full = JSON.parse(fullRaw) as unknown;
  if (!isJsonRecord(full)) {
    throw new CliError("ruleset response is invalid");
  }

  const currentRules = Array.isArray(full.rules) ? full.rules : [];
  if (!currentRules.some((rule) => isJsonRecord(rule) && rule.type === "required_status_checks")) {
    throw new CliError("required_status_checks rule is missing");
  }

  const rules = currentRules.map((rule) => normalizeRequiredStatusRule(rule, policy));
  const payload = {
    name: full.name,
    target: full.target,
    enforcement: full.enforcement,
    bypass_actors: Array.isArray(full.bypass_actors) ? full.bypass_actors : [],
    conditions: full.conditions,
    rules,
  };

  if (dryValue === "true") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  await runText(
    "gh",
    [
      "api",
      "--method",
      "PUT",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      `repos/${repository}/rulesets/${summary.id}`,
      "--input",
      "-",
    ],
    {
      input: JSON.stringify(payload),
      env: githubEnvironment(token),
    },
  );

  const verifiedRaw = await runGithubCli(
    ["api", `repos/${repository}/rulesets/${summary.id}`],
    token,
  );
  const verified = JSON.parse(verifiedRaw) as unknown;
  if (!isJsonRecord(verified) || !Array.isArray(verified.rules)) {
    throw new CliError("updated ruleset response is invalid");
  }

  const required = verified.rules.find(
    (rule) => isJsonRecord(rule) && rule.type === "required_status_checks",
  );
  if (!isJsonRecord(required) || !isJsonRecord(required.parameters)) {
    throw new CliError("updated required_status_checks rule is invalid");
  }

  const actualChecks = Array.isArray(required.parameters.required_status_checks)
    ? required.parameters.required_status_checks
    : [];
  const expectedChecks = policy.required_status_checks.map((context) => ({ context }));
  if (!isDeepStrictEqual(actualChecks, expectedChecks)) {
    throw new CliError(
      `required status check mismatch: expected=${JSON.stringify(expectedChecks)} actual=${JSON.stringify(actualChecks)}`,
    );
  }

  console.log(`repository ruleset applied: ${repository} / ${policy.name}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
