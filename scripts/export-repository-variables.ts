import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { aiAgentRuntimeEntries, parseAiAgentConfig } from "./ai-agent-config.ts";
import { decodeGatewayOpsVariables, validateGatewayOpsVariables } from "./gateway-ops-variables.ts";
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

// MCP Hub has a strict, public-variable-only export path. Never inject the
// full GitHub vars context into this deploy, since operators may accidentally
// define a credential under Variables instead of Secrets.
const mcpHubPublicVariableNames = [
  "CLOUDFLARE_ACCOUNT_ID_SECONDARY",
  "MCP_D1_ID",
  "MCP_PUBLIC_URL",
  "MCP_ACTIVE_ID",
  "MCP_ACCESS_ISSUER",
  "MCP_ACCESS_AUD",
  "MCP_AUTH_MODE",
  "MCP_OAUTH_TTL",
  "GMC_WRITE_MODE",
  "GMC_CONTENT_MODE",
  "MCP_CRYPTO_SECRET_SYNC",
];

export function scopedMcpHubVariables(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of mcpHubPublicVariableNames) {
    const value = environment[`AW_MCP_HUB_VAR_${name}`];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * AI Gateway runtime Variables are supplied by the protected ai-gateway-ops
 * Environment. The Action Worker repository supplies only Cloudflare account
 * metadata. Repository-owned AIG Variables are rejected before handoff.
 */
export function mergeApprovedGatewayOpsVariables(
  variables: Record<string, string>,
  sourceRepository: string | undefined,
  deployEnvironment: string | undefined,
  fromRepository: Readonly<Record<string, string | undefined>>,
  credentialEnvironment?: string
): Record<string, string> {
  if (sourceRepository !== "fongap-labs/ai-gateway" || deployEnvironment !== "production") {
    if (Object.values(fromRepository).some((value) => Boolean(value))) {
      throw new CliError(
        "Gateway repository Variable handoff is not authorized for this deployment.",
        77
      );
    }
    return variables;
  }
  if (credentialEnvironment !== "ai-gateway-ops") {
    throw new CliError(
      "AI Gateway production requires the protected ai-gateway-ops credential Environment.",
      77
    );
  }
  if (Object.keys(fromRepository).some((name) => name.startsWith("AIG_"))) {
    throw new CliError(
      "AI Gateway runtime Variables belong to ai-gateway-ops, not Action Worker repository.",
      77
    );
  }
  const opsVariables = Object.fromEntries(
    Object.entries(variables).filter(([name]) => name.startsWith("AIG_"))
  );
  const approved = validateGatewayOpsVariables({
    ...opsVariables,
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: fromRepository.CLOUDFLARE_ACCOUNT_ID_SECONDARY,
  });
  if (!approved.AIG_MODELS_CONFIG?.trim()) {
    throw new CliError(
      "Protected ai-gateway-ops Variable AIG_MODELS_CONFIG is unavailable or empty.",
      77
    );
  }
  // Do not pass unrelated Action Worker repository or organization Variables
  // to the source-owned deploy entrypoint.
  return approved;
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
  const value =
    process.env.DEPLOY_SOURCE_REPOSITORY === "fongap-labs/mcp-hub"
      ? scopedMcpHubVariables(process.env)
      : parseJson(
          process.env.REPOSITORY_VARS_JSON || "{}",
          "::error::Repository Variables payload must be valid JSON."
        );
  const sorted = mergeApprovedGatewayOpsVariables(
    Object.fromEntries(variableEntries(value)),
    process.env.DEPLOY_SOURCE_REPOSITORY,
    process.env.DEPLOY_ENVIRONMENT,
    process.env.AW_GATEWAY_VARIABLES_B64_FROM_REPOSITORY
      ? decodeGatewayOpsVariables(process.env.AW_GATEWAY_VARIABLES_B64_FROM_REPOSITORY)
      : {},
    process.env.DEPLOY_CREDENTIAL_ENVIRONMENT
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
