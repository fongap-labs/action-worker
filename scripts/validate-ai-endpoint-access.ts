import {
  CliError,
  handleError,
  isMain,
} from "./runtime-command.ts";
import {
  enabledAiModels,
  parseAiAgentConfig,
  type AiAgentConfig,
} from "./ai-agent-config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveModelsEndpoint(baseUrl: string): string {
  const gateway = baseUrl.replace(/\/+$/, "");
  if (gateway.endsWith("/v1/chat/completions")) {
    return gateway.slice(0, -"/chat/completions".length) + "/models";
  }
  if (gateway.endsWith("/chat/completions")) {
    return gateway.slice(0, -"/chat/completions".length) + "/models";
  }
  if (gateway.endsWith("/v1")) return `${gateway}/models`;
  return `${gateway}/v1/models`;
}

export function requiredPrAiModels(config: AiAgentConfig, explicitModel = ""): string[] {
  const models = new Set(enabledAiModels(config, ["triage", "review"]));
  const model = explicitModel.trim();
  if (model && model !== "auto") models.add(model);
  if (models.size === 0) {
    throw new CliError("ERROR: enabled PR AI agents and explicit bootstrap define no models.", 65);
  }
  return [...models].sort();
}

export function visibleModelIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new CliError("ERROR: AI endpoint /v1/models returned an invalid payload.", 65);
  }
  const ids = value.data
    .map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id.trim() : "")
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new CliError("Usage: validate-ai-endpoint-access.ts", 64);
  }

  const gatewayUrl = process.env.AI_ENDPOINT_URL ?? "";
  const token = process.env.AI_ENDPOINT_TOKEN ?? "";
  if (!gatewayUrl || !token) {
    throw new CliError("ERROR: AI_ENDPOINT_URL and AI_ENDPOINT_TOKEN are required.", 65);
  }

  const config = parseAiAgentConfig(process.env.AW_AI_AGENT_CONFIG ?? "");
  const required = requiredPrAiModels(
    config,
    process.env.AI_ENDPOINT_REQUIRED_MODEL ?? "",
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(resolveModelsEndpoint(gatewayUrl), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch {
    throw new CliError("ERROR: AI endpoint model access check failed before a response was received.", 65);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new CliError(`ERROR: AI endpoint model access check returned HTTP ${response.status}.`, 65);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new CliError("ERROR: AI endpoint /v1/models returned non-JSON content.", 65);
  }

  const visible = visibleModelIds(payload);
  const visibleSet = new Set(visible);
  const missing = required.filter((model) => !visibleSet.has(model));
  if (missing.length > 0) {
    throw new CliError(
      `ERROR: Configured AI endpoint credential cannot call required PR AI model(s): ${missing.join(", ")}. Visible models: ${visible.join(", ") || "none"}.`,
      65,
    );
  }

  console.log(`AI endpoint access verified. Required models: ${required.join(", ")}. Visible models: ${visible.join(", ")}.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
