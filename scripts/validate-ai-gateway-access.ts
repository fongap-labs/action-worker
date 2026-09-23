import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

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

export function requiredAiModels(triagePolicy: unknown, reviewPolicy: unknown): string[] {
  if (!isRecord(triagePolicy) || !isRecord(reviewPolicy) || !isRecord(reviewPolicy.agents)) {
    throw new CliError("ERROR: invalid AI governance policy.", 65);
  }

  const models = new Set<string>();
  for (const value of [triagePolicy.model, triagePolicy.deep_model]) {
    if (typeof value === "string" && value.trim()) models.add(value.trim());
  }
  for (const agent of Object.values(reviewPolicy.agents)) {
    if (!isRecord(agent)) continue;
    if (typeof agent.model === "string" && agent.model.trim()) models.add(agent.model.trim());
  }

  if (models.size === 0) {
    throw new CliError("ERROR: AI governance policy defines no models.", 65);
  }
  return [...models].sort();
}

export function visibleModelIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new CliError("ERROR: AI Gateway /v1/models returned an invalid payload.", 65);
  }
  const ids = value.data
    .map((entry) => isRecord(entry) && typeof entry.id === "string" ? entry.id.trim() : "")
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new CliError("Usage: validate-ai-gateway-access.ts <triage-policy> <review-policy>", 64);
  }

  const gatewayUrl = process.env.AI_GATEWAY_URL ?? "";
  const token = process.env.AI_GATEWAY_TOKEN ?? "";
  if (!gatewayUrl || !token) {
    throw new CliError("ERROR: AI_GATEWAY_URL and AI_GATEWAY_TOKEN are required.", 65);
  }

  const required = requiredAiModels(await readJson(args[0] ?? ""), await readJson(args[1] ?? ""));
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
    throw new CliError("ERROR: AI Gateway model access check failed before a response was received.", 65);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new CliError(`ERROR: AI Gateway model access check returned HTTP ${response.status}.`, 65);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new CliError("ERROR: AI Gateway /v1/models returned non-JSON content.", 65);
  }

  const visible = visibleModelIds(payload);
  const visibleSet = new Set(visible);
  const missing = required.filter((model) => !visibleSet.has(model));
  if (missing.length > 0) {
    throw new CliError(
      `ERROR: AIG_ACCESS_KEY_AGENT cannot call required AI governance model(s): ${missing.join(", ")}. Visible models: ${visible.join(", ") || "none"}.`,
      65,
    );
  }

  console.log(`AI Gateway access verified. Required models: ${required.join(", ")}. Visible models: ${visible.join(", ")}.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
