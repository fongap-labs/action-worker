import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { aiAgentRuntimeEntries, parseAiAgentConfig } from "./ai-agent-config.ts";
import { validateGatewayOpsVariables } from "./gateway-ops-variables.ts";
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
export function mergeApprovedGatewayOpsVariables(
  variables: Record<string, string>,
  sourceRepository: string | undefined,
  deployEnvironment: string | undefined,
  fromOps: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  if (sourceRepository !== "fongap-labs/ai-gateway" || deployEnvironment !== "production") {
    if (Object.values(fromOps).some((value) => Boolean(value))) {
      throw new CliError("Ops Variable handoff is not authorized for this deployment.", 77);
    }
    return variables;
  }
  const approved = validateGatewayOpsVariables(fromOps);
  const merged = { ...variables };
  for (const [name, value] of Object.entries(approved)) {
    const existing = merged[name];
    if (existing !== undefined) {
      const matches =
        name === "AIG_PUBLIC_URL"
          ? existing === value || existing === value + "/"
          : existing === value;
      if (!matches) {
        throw new CliError("AI Gateway has conflicting Variable sources: " + name + ".", 77);
      }
    }
    merged[name] = value;
  }
  return merged;
}

/** Compatibility for callers that have not moved optional metadata to protected ops. */
export function mergeApprovedGatewayAccountId(
  variables: Record<string, string>,
  sourceRepository: string | undefined,
  deployEnvironment: string | undefined,
  accountId: string | undefined
): Record<string, string> {
  return mergeApprovedGatewayOpsVariables(variables, sourceRepository, deployEnvironment, {
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: accountId,
  });
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
  const sorted = mergeApprovedGatewayOpsVariables(
    Object.fromEntries(variableEntries(value)),
    process.env.DEPLOY_SOURCE_REPOSITORY,
    process.env.DEPLOY_ENVIRONMENT,
    {
      CLOUDFLARE_ACCOUNT_ID_SECONDARY: process.env.AW_GATEWAY_ACCOUNT_ID_FROM_OPS,
      AIG_PUBLIC_URL: process.env.AW_GATEWAY_PUBLIC_URL_FROM_OPS,
      AIG_AFFINITY_KV_ID: process.env.AW_GATEWAY_AFFINITY_KV_ID_FROM_OPS,
      AIG_USAGE_D1_ID: process.env.AW_GATEWAY_USAGE_D1_ID_FROM_OPS,
      AIG_ANALYTICS_DATASET: process.env.AW_GATEWAY_ANALYTICS_DATASET_FROM_OPS,
    }
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
