import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { aiAgentRuntimeEntries, parseAiAgentConfig } from "./ai-agent-config.ts";
import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

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

export function variableEntries(value: unknown): Array<[string, string]> {
  if (!isJsonRecord(value)) {
    throw new CliError("::error::Repository Variables payload must be a JSON object.");
  }
  const entries: Array<[string, string]> = [];
  for (const name of Object.keys(value).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new CliError(`::error::Invalid Repository Variable name: ${name}`);
    }
    entries.push([name, valueText(value[name])]);
  }
  return entries;
}

/**
 * The AI Gateway production account ID is a non-sensitive Variable owned by
 * this control repository's protected ai-gateway-ops Environment. Only this
 * deployment key may receive it. Never import other ops variables or Secrets.
 */
export function mergeApprovedGatewayAccountId(
  variables: Record<string, string>,
  sourceRepository: string | undefined,
  deployEnvironment: string | undefined,
  accountId: string | undefined
): Record<string, string> {
  if (sourceRepository !== "fongap-labs/ai-gateway" || deployEnvironment !== "production") {
    if (accountId) {
      throw new CliError("Ops Account ID handoff is not authorized for this deployment.", 77);
    }
    return variables;
  }
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new CliError("Approved AI Gateway ops Account ID is unavailable.", 77);
  }
  const existing = variables.CLOUDFLARE_ACCOUNT_ID_SECONDARY;
  if (existing !== undefined && existing !== accountId) {
    throw new CliError("AI Gateway Account ID has conflicting Variable sources.", 77);
  }
  return { ...variables, CLOUDFLARE_ACCOUNT_ID_SECONDARY: accountId };
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const githubEnv = process.env.GITHUB_ENV ?? "";
  if (!runnerTemp) {
    throw new CliError("::error::RUNNER_TEMP is not set.");
  }
  if (!githubEnv) {
    throw new CliError("::error::GITHUB_ENV is not set.");
  }
  const value = parseJson(
    process.env.REPOSITORY_VARS_JSON || "{}",
    "::error::Repository Variables payload must be valid JSON."
  );
  const sorted = mergeApprovedGatewayAccountId(
    Object.fromEntries(variableEntries(value)),
    process.env.DEPLOY_SOURCE_REPOSITORY,
    process.env.DEPLOY_ENVIRONMENT,
    process.env.AW_GATEWAY_ACCOUNT_ID_FROM_OPS
  );
  const entries = variableEntries(sorted);
  const aiAgentConfig = parseAiAgentConfig(sorted.AW_AI_AGENT_CONFIG ?? "");
  const agentEntries = aiAgentRuntimeEntries(aiAgentConfig);
  const repositoryNames = new Set(entries.map(([name]) => name));
  for (const [name] of agentEntries) {
    if (repositoryNames.has(name)) {
      throw new CliError(
        `::error::Repository Variable "${name}" conflicts with an AI Agent runtime variable derived from AW_AI_AGENT_CONFIG.`,
        65
      );
    }
  }
  const snapshot = `${runnerTemp}/action-worker-repository-vars.json`;
  await writeFile(snapshot, JSON.stringify(sorted), "utf8");
  await chmod(snapshot, 0o600);
  let _count = 0;
  for (const [name, text] of [...entries, ...agentEntries]) {
    if (isReserved(name)) {
      continue;
    }
    let delimiter = `__ACTION_WORKER_VAR_${randomBytes(12).toString("hex")}__`;
    while (text.split(/\r?\n/).includes(delimiter)) {
      delimiter = `__ACTION_WORKER_VAR_${randomBytes(12).toString("hex")}__`;
    }
    await appendLines(githubEnv, [`${name}<<${delimiter}`, text, delimiter]);
    _count += 1;
  }
  console.log(
    `Repository Variables exported: ${entries.length}; AI Agent runtime variables exported: ${agentEntries.length}`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
