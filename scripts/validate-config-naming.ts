import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { CliError, handleError, isMain, runText } from "./runtime-command.ts";

const platformNames = new Set([
  "GH_TOKEN",
  "NODE_OPTIONS",
  "GITHUB_ACTION",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  "GITHUB_ACTOR_ID",
  "GITHUB_API_URL",
  "GITHUB_BASE_REF",
  "GITHUB_ENV",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_GRAPHQL_URL",
  "GITHUB_HEAD_REF",
  "GITHUB_JOB",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REF_PROTECTED",
  "GITHUB_REF_TYPE",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_RETENTION_DAYS",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_WORKSPACE",
]);

const tokenPattern = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const workflowExternalPattern = /\$\{\{\s*(?:vars|secrets)\.([A-Z][A-Z0-9_]*)/g;
type ExternalPolicy = {
  system_prefixes: string[];
  platform_prefixes: string[];
  forbidden_credential_terms: string[];
  boolean_required_prefixes: string[];
  boolean_action_terms: string[];
  boolean_suffixes: string[];
  mode_suffixes: string[];
};

const fallbackExternalPolicy: ExternalPolicy = {
  system_prefixes: [
    "AW_", "GMC_", "MCP_", "AIG_", "AI_GATEWAY_", "APP_SOURCE_", "DELTA_",
    "SERVER_EDGE_", "CLOUDFLARE_", "GITHUB_", "AWS_", "GCP_", "ALGOLIA_", "TAILSCALE_",
  ],
  platform_prefixes: ["RUNNER_", "ACTIONS_"],
  forbidden_credential_terms: ["PAT"],
  boolean_required_prefixes: ["IS", "HAS", "CAN", "SHOULD"],
  boolean_action_terms: ["ALLOW", "ENABLE", "DISABLE", "EXPOSE", "INCLUDE"],
  boolean_suffixes: ["_ENABLED"],
  mode_suffixes: ["_MODE"],
};

function loadExternalPolicy(): ExternalPolicy {
  try {
    const raw = JSON.parse(
      readFileSync(new URL("../policies/naming.json", import.meta.url), "utf8")
    ) as Record<string, unknown>;
    const config = raw.external_configuration;
    if (raw.schema_version !== 1 || typeof config !== "object" || config === null) {
      throw new CliError("Invalid external-configuration naming policy.", 65);
    }
    const value = config as Record<string, unknown>;
    const array = (key: keyof ExternalPolicy): string[] => {
      const candidate = value[key];
      if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === "string")) {
        throw new CliError(`Invalid naming policy field: external_configuration.${key}.`, 65);
      }
      return candidate;
    };
    return {
      system_prefixes: array("system_prefixes"),
      platform_prefixes: array("platform_prefixes"),
      forbidden_credential_terms: array("forbidden_credential_terms"),
      boolean_required_prefixes: array("boolean_required_prefixes"),
      boolean_action_terms: array("boolean_action_terms"),
      boolean_suffixes: array("boolean_suffixes"),
      mode_suffixes: array("mode_suffixes"),
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallbackExternalPolicy;
    }
    throw new CliError(`Unable to read policies/naming.json: ${String(error)}`, 65);
  }
}

const externalPolicy = loadExternalPolicy();
const selfIdentifyingPrefixes = externalPolicy.system_prefixes;

function isPlatformName(name: string): boolean {
  return (
    platformNames.has(name) ||
    externalPolicy.platform_prefixes.some((prefix) => name.startsWith(prefix))
  );
}

const ownerScopes = new Set(["projects", "apps", "services", "tools", "crates", "skills"]);

function scopedOwnerPrefix(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    if (!ownerScopes.has(segment)) continue;
    const owner = segments[index + 1] ?? "";
    const token = owner
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
    return token ? `${token}_` : null;
  }
  return null;
}

function isSelfIdentifying(name: string, path: string): boolean {
  if (selfIdentifyingPrefixes.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  const ownerPrefix = scopedOwnerPrefix(path);
  return Boolean(ownerPrefix && name.startsWith(ownerPrefix));
}

function externalNames(path: string, text: string): string[] {
  if (
    path.startsWith(".github/workflows/") &&
    [".yml", ".yaml"].includes(extname(path).toLowerCase())
  ) {
    return [
      ...new Set(
        [...text.matchAll(workflowExternalPattern)].map((match) => match[1]!).filter(Boolean)
      ),
    ].sort();
  }
  return [...new Set(text.match(tokenPattern) ?? [])].sort();
}

function shouldScan(path: string): boolean {
  if (
    path.startsWith(".github/workflows/") &&
    [".yml", ".yaml"].includes(extname(path).toLowerCase())
  ) {
    return true;
  }
  const name = basename(path);
  if (
    [".env", ".env.example", ".env.variables", ".secrets.required", ".dev.vars.example"].includes(
      name
    )
  ) {
    return true;
  }
  if (name === "wrangler.jsonc") {
    return true;
  }
  return (
    path.split("/").includes("config") &&
    [".json", ".jsonc", ".toml", ".yml", ".yaml"].includes(extname(path).toLowerCase())
  );
}

export function validateConfigText(path: string, text: string): string[] {
  const errors: string[] = [];
  const names = externalNames(path, text);

  for (const name of names) {
    if (isPlatformName(name)) {
      continue;
    }
    if (!isSelfIdentifying(name, path)) {
      errors.push(
        `${path}: external configuration '${name}' must identify its owning system without repository context`
      );
    }
    if (
      externalPolicy.forbidden_credential_terms.some((term) => name.split("_").includes(term))
    ) {
      errors.push(`${path}: credential '${name}' must use TOKEN or KEY instead of a forbidden credential term`);
    }
    const booleanPrefixPattern = new RegExp(
      `(?:^|_)(?:${externalPolicy.boolean_required_prefixes.join("|")})_`
    );
    const booleanActionPattern = new RegExp(
      `(?:^|_)(?:${externalPolicy.boolean_action_terms.join("|")})_`
    );
    const usesBooleanPrefix = booleanPrefixPattern.test(name);
    const isModeValue = externalPolicy.mode_suffixes.some((suffix) => name.endsWith(suffix));
    const looksBoolean =
      !isModeValue &&
      (booleanActionPattern.test(name) ||
        externalPolicy.boolean_suffixes.some((suffix) => name.endsWith(suffix)));
    if (looksBoolean && !usesBooleanPrefix) {
      errors.push(
        `${path}: Boolean configuration '${name}' must include an IS_, HAS_, CAN_, or SHOULD_ semantic segment`
      );
    }
  }
  return errors;
}

export async function validateConfigNames(base: string, head: string): Promise<number> {
  const changed = await runText("git", ["diff", "--name-only", "--diff-filter=ACMR", base, head]);
  const paths = changed ? changed.split(/\r?\n/).filter(Boolean).filter(shouldScan) : [];
  const errors: string[] = [];

  for (const path of paths) {
    try {
      const text = await readFile(path, "utf8");
      errors.push(...validateConfigText(path, text));
    } catch {
      // Deleted or unavailable files are excluded by --diff-filter and do not block validation.
    }
  }
  if (errors.length > 0) {
    for (const error of [...new Set(errors)].sort()) {
      console.error(`::error::${error}`);
    }
    return 1;
  }

  console.log(`Configuration naming conventions passed (${paths.length} changed config files).`);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new CliError("Usage: validate-config-naming.ts <base-sha> <head-sha>", 64);
  }
  process.exitCode = await validateConfigNames(args[0] ?? "", args[1] ?? "");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
