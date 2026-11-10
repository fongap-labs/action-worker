import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { aiAgentRuntimeEntries, parseAiAgentConfig } from "./ai-agent-config.ts";
import {
  decodeGatewayOpsVariables,
  isGatewayOwnedVariableName,
  validateGatewayOpsVariables,
} from "./gateway-ops-variables.ts";
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
 * AI Gateway production Variables are validated in the protected ops job.
 * The deploy job also binds the ai-gateway-ops Environment, which means
 * toJSON(vars) legitimately contains the same inherited values. Only an
 * approved, matching snapshot may be exported; unapproved names/values fail.
 */
export function mergeApprovedGatewayOpsVariables(
  variables: Record<string, string>,
  sourceRepository: string | undefined,
  deployEnvironment: string | undefined,
  fromOps: Readonly<Record<string, string | undefined>>,
  credentialEnvironment?: string
): Record<string, string> {
  if (sourceRepository !== "fongap-labs/ai-gateway" || deployEnvironment !== "production") {
    if (Object.values(fromOps).some((value) => Boolean(value))) {
      throw new CliError("Ops Variable handoff is not authorized for this deployment.", 77);
    }
    return variables;
  }
  if (credentialEnvironment !== "ai-gateway-ops") {
    throw new CliError(
      "AI Gateway production requires the protected ai-gateway-ops credential Environment.",
      77
    );
  }
  const approved = validateGatewayOpsVariables(fromOps);
  const inherited = Object.fromEntries(
    Object.entries(variables).filter(([name]) => isGatewayOwnedVariableName(name))
  );
  // Normalize inherited values (notably an HTTPS origin with a trailing slash)
  // and reject retired OAuth bindings, misplaced Secrets, and invalid values.
  const validatedInherited = validateGatewayOpsVariables({
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: approved.CLOUDFLARE_ACCOUNT_ID_SECONDARY,
    ...inherited,
  });
  const conflicts = Object.keys(inherited)
    .filter((name) => validatedInherited[name] !== approved[name])
    .sort();
  if (conflicts.length > 0) {
    throw new CliError(
      "AI Gateway deploy Variables conflict with the approved protected ops snapshot: " +
        conflicts.join(", ") +
        ".",
      77
    );
  }
  // The protected handoff is authoritative; never let inherited values override it.
  return { ...variables, ...approved };
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
    process.env.AW_GATEWAY_VARIABLES_B64_FROM_OPS
      ? decodeGatewayOpsVariables(process.env.AW_GATEWAY_VARIABLES_B64_FROM_OPS)
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
