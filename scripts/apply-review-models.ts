import { type AiAgentConfigEntry, parseAiAgentConfig } from "./ai-agent-config.ts";
import { isJsonRecord } from "./github-api.ts";
import { resolveModelsEndpoint } from "./validate-ai-endpoint-access.ts";
import { CliError, handleError, isMain, readJson, runText } from "./runtime-command.ts";

const variableName = "AW_AI_AGENT_CONFIG";
const requiredRoutes = ["code", "workflow", "release", "security", "architecture", "deep"];

type ReviewModelPolicy = { schema_version: 1; model: "Audit-Code" };

export function parseReviewModelPolicy(value: unknown): ReviewModelPolicy {
  if (
    !isJsonRecord(value) ||
    value.schema_version !== 1 ||
    value.model !== "Audit-Code" ||
    Object.keys(value).length !== 2
  ) {
    throw new CliError("::error::AI Review must use only Audit-Code.", 65);
  }
  return { schema_version: 1, model: "Audit-Code" };
}

export function applyReviewModels(rawConfig: string, policyValue: unknown): string {
  const config = parseAiAgentConfig(rawConfig);
  const policy = parseReviewModelPolicy(policyValue);
  const agents: Record<string, AiAgentConfigEntry> = {
    ...config.agents,
    review: { enabled: true, model: policy.model, routes: {} },
  };
  // An enabled PR triage agent also uses Audit-Code; unrelated agents remain unchanged.
  if (agents.triage?.enabled === true) {
    agents.triage = { enabled: true, model: policy.model, routes: {} };
  }
  const result = JSON.stringify({ schema_version: 1, agents });
  parseAiAgentConfig(result);
  return result;
}

export function hasAuditCode(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    Array.isArray(value.data) &&
    value.data.some((entry) => isJsonRecord(entry) && entry.id === "Audit-Code")
  );
}

export async function checkAuditCodeAccess(endpoint: string, token: string): Promise<void> {
  if (!endpoint || !token) {
    throw new CliError("::error::AI Gateway URL and agent token are required.", 65);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(resolveModelsEndpoint(endpoint), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CliError(`::error::AI Gateway model access returned HTTP ${response.status}.`, 65);
    }
    const payload = await response.json() as unknown;
    if (!hasAuditCode(payload)) {
      throw new CliError(
        "::error::AI Gateway has not authorized Audit-Code for its AGENT key. Configure a usable node mapping and AIG_ACCESS_MODELS_AGENT before syncing Action Worker.",
        65
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function getVariable(repository: string, token: string): Promise<string> {
  const response = await runText(
    "gh",
    ["api", `repos/${repository}/actions/variables/${variableName}`],
    { env: { ...process.env, GH_TOKEN: token }, timeoutMs: 30_000 }
  );
  const value = JSON.parse(response) as unknown;
  if (!isJsonRecord(value) || typeof value.value !== "string") {
    throw new CliError("::error::AI agent variable response is invalid.", 65);
  }
  return value.value;
}

async function main(): Promise<void> {
  const repository = process.argv[2] ?? "";
  const token = process.env.GH_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    throw new CliError("::error::Review model sync requires a repository and admin token.", 65);
  }
  const policy = await readJson("policies/review-models.json");
  const current = await getVariable(repository, token);
  const next = applyReviewModels(current, policy);
  // Fail closed without replacing the previous working model routing.
  await checkAuditCodeAccess(process.env.AI_GATEWAY_URL ?? "", process.env.AI_GATEWAY_TOKEN ?? "");
  if (JSON.stringify(JSON.parse(current)) === next) {
    console.log("AI Review already uses Audit-Code.");
    return;
  }
  await runText(
    "gh",
    ["api", "--method", "PATCH", `repos/${repository}/actions/variables/${variableName}`, "--input", "-"],
    {
      env: { ...process.env, GH_TOKEN: token },
      input: JSON.stringify({ name: variableName, value: next }),
      timeoutMs: 30_000,
    }
  );
  const saved = await getVariable(repository, token);
  if (JSON.stringify(JSON.parse(saved)) !== next) {
    throw new CliError("::error::AI Review model variable did not match source policy.", 65);
  }
  console.log("AI Review now uses Audit-Code; unrelated agents are unchanged.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
