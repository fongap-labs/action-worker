import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isJsonRecord } from "./github-api.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

const requiredKeys = [
  "schema_version",
  "request_id",
  "project",
  "bootstrap_ref",
  "repository",
] as const;
const optionalKeys = ["agent_domain", "operation"] as const;
const optionalKeyPattern = /^[a-z][a-z0-9-]*$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateDispatch(value: unknown): { agent_domain: string; operation: string } {
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
    throw new CliError(
      `::error::Unsupported schema_version=${String(value.schema_version)}; only version 1 is supported.`,
      65
    );
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
  if (!repositoryPattern.test(String(value.repository))) {
    throw new CliError("::error::repository must use owner/name format.", 64);
  }
  const unknown = Object.keys(value).filter(
    (key) =>
      !requiredKeys.includes(key as (typeof requiredKeys)[number]) &&
      !optionalKeys.includes(key as (typeof optionalKeys)[number])
  );
  if (unknown.length > 0) {
    throw new CliError(`::error::Unsupported fields: ${unknown.join(", ")}.`, 64);
  }

  const agentDomain = typeof value.agent_domain === "string" ? value.agent_domain : "coding";
  if (!optionalKeyPattern.test(agentDomain)) {
    throw new CliError("::error::agent_domain must be lower-kebab-case.", 64);
  }
  const operation = typeof value.operation === "string" ? value.operation : "task";
  const validOperations = new Set([
    "ci",
    "review",
    "build",
    "release",
    "deploy",
    "task",
    "scheduled",
  ]);
  if (!validOperations.has(operation)) {
    throw new CliError(`::error::Unknown operation: ${operation}.`, 64);
  }
  return { agent_domain: agentDomain, operation };
}

/** Serialize only an opaque per-project group across Jobs; masked source names cannot be job outputs. */
export function taskConcurrencyGroup(repository: string, project: string): string {
  if (!repositoryPattern.test(repository) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(project)) {
    throw new CliError("::error::Task concurrency identity is invalid.", 64);
  }
  return createHash("sha256")
    .update(JSON.stringify([repository.toLowerCase(), project]))
    .digest("hex")
    .slice(0, 32);
}

/** Fail closed before minting source credentials or running any legacy task code. */
export function assertTaskExecutionAllowed(
  policy: unknown,
  repository: string,
  project: string
): void {
  const productKeyPattern =
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  if (
    !isJsonRecord(policy) ||
    policy.schema_version !== 1 ||
    Object.keys(policy).sort().join(",") !== "deploy_only,schema_version" ||
    !Array.isArray(policy.deploy_only) ||
    policy.deploy_only.some((key) => typeof key !== "string" || !productKeyPattern.test(key)) ||
    new Set(policy.deploy_only).size !== policy.deploy_only.length
  ) {
    throw new CliError("::error::Task execution modes policy is invalid.", 65);
  }
  if (policy.deploy_only.includes(`${repository}/${project}`)) {
    throw new CliError(
      "::error::This product uses the protected deployment pipeline; generic Task Dispatch is disabled.",
      77
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let value: unknown;
  if (args.length === 1) {
    value = parseJson(args[0] ?? "", "::error::client_payload is not valid JSON.", 64);
  } else if (args.length === 0 && process.env.GITHUB_EVENT_PATH) {
    const event = parseJson(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
      "::error::GitHub event is not valid JSON.",
      64
    );
    if (!isJsonRecord(event)) {
      throw new CliError("::error::GitHub event must be a JSON object.", 64);
    }
    value = event.client_payload;
  } else {
    throw new CliError("::error::A GitHub event file or one client_payload JSON is required.", 64);
  }
  const { agent_domain: agentDomain, operation } = validateDispatch(value);
  const payload = value as Record<string, unknown>;
  const repositoryPolicy = readRepositoryPolicyText();
  if (!repositoryPolicy) {
    throw new CliError("::error::Missing Repository Variable: AW_REPOSITORY_POLICY.", 65);
  }
  validateRepositoryCapability(
    String(payload.repository),
    parseJson(repositoryPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65),
    "task"
  );
  // The control plane blocks the legacy task executor even for an older, otherwise
  // trusted source SHA. Source-only removal of task.json cannot guard direct dispatch.
  const modes = parseJson(
    await readFile("policies/task-execution-modes.json", "utf8"),
    "::error::Task execution modes policy must be valid JSON.",
    65
  );
  assertTaskExecutionAllowed(modes, String(payload.repository), String(payload.project));
  await appendLines(process.env.GITHUB_OUTPUT, [
    `schema_version=${String(payload.schema_version)}`,
    `task_group=${taskConcurrencyGroup(String(payload.repository), String(payload.project))}`,
    `request_id=${String(payload.request_id)}`,
    `project=${String(payload.project)}`,
    `bootstrap_ref=${String(payload.bootstrap_ref)}`,
    `repository=${String(payload.repository)}`,
    `agent_domain=${agentDomain}`,
    `operation=${operation}`,
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
