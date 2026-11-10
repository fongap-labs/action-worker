import { type AiAgentConfig, enabledAiModels, parseAiAgentConfig } from "./ai-agent-config.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveModelsEndpoint(baseUrl: string): string {
  const gateway = baseUrl.replace(/\/+$/, "");
  if (gateway.endsWith("/v1/chat/completions")) {
    return `${gateway.slice(0, -"/chat/completions".length)}/models`;
  }
  if (gateway.endsWith("/chat/completions")) {
    return `${gateway.slice(0, -"/chat/completions".length)}/models`;
  }
  if (gateway.endsWith("/v1")) return `${gateway}/models`;
  return `${gateway}/v1/models`;
}

export function resolveCompletionsEndpoint(baseUrl: string): string {
  const gateway = baseUrl.replace(/\/+$/, "");
  if (gateway.endsWith("/chat/completions")) return gateway;
  if (gateway.endsWith("/v1")) return `${gateway}/chat/completions`;
  return `${gateway}/v1/chat/completions`;
}

export function completionHasText(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.choices)) return false;
  return value.choices.some((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return false;
    const content = choice.message.content;
    if (typeof content === "string") return content.trim().length > 0;
    return (
      Array.isArray(content) &&
      content.some(
        (part) => isRecord(part) && typeof part.text === "string" && part.text.trim().length > 0
      )
    );
  });
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
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id.trim() : ""))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * Short, bounded retries are only for transient endpoint failures. Credential
 * errors (401/403), invalid models (400/404), and malformed responses fail
 * immediately. Never print provider response bodies or authentication headers.
 */
export function retryableProbeStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function probeRetryDelayMs(retryAfter: string | null, attempt: number): number {
  const fallback = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  if (retryAfter === null) return fallback;
  const text = retryAfter.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 1000), 30_000);
  }
  const retryDate = Date.parse(text);
  if (Number.isFinite(retryDate)) {
    return Math.min(Math.max(retryDate - Date.now(), 1000), 30_000);
  }
  return fallback;
}

type ProbeRequestOptions = {
  timeoutMs: number;
  maxAttempts?: number;
  fetcher?: typeof fetch;
  wait?: (durationMs: number) => Promise<void>;
  onRetry?: (reason: string, attempt: number, waitMs: number) => void;
};

export async function requestWithTransientRetry(
  url: string,
  init: RequestInit,
  options: ProbeRequestOptions
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new CliError("ERROR: Invalid AI endpoint retry count.", 65);
  }
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetcher(url, { ...init, signal: controller.signal });
    } catch {
      if (attempt === maxAttempts) {
        throw new CliError("ERROR: AI endpoint probe failed to connect after bounded retries.", 65);
      }
    } finally {
      clearTimeout(timeout);
    }

    if (response !== undefined) {
      if (!retryableProbeStatus(response.status) || attempt === maxAttempts) return response;
    }
    const delayMs = probeRetryDelayMs(response?.headers.get("retry-after") ?? null, attempt);
    options.onRetry?.(
      response === undefined ? "network" : `HTTP ${response.status}`,
      attempt,
      delayMs
    );
    await response?.body?.cancel().catch(() => undefined);
    await wait(delayMs);
  }
  throw new CliError("ERROR: AI endpoint probe exhausted bounded retries.", 65);
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
  const required = requiredPrAiModels(config, process.env.AI_ENDPOINT_REQUIRED_MODEL ?? "");
  const retryNotice = (reason: string, attempt: number, waitMs: number): void => {
    console.error(
      `::warning::AI endpoint probe transient ${reason}; retry ${attempt}/2 after ${waitMs}ms.`
    );
  };
  const response = await requestWithTransientRetry(
    resolveModelsEndpoint(gatewayUrl),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
    { timeoutMs: 15_000, onRetry: retryNotice }
  );

  if (!response.ok) {
    throw new CliError(
      `ERROR: AI endpoint model access check returned HTTP ${response.status}.`,
      65
    );
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
      65
    );
  }

  // /v1/models can advertise an alias whose upstream is unusable. Confirm one real inference
  // without sending any private repository content; report only HTTP status, never provider text.
  const probeModel = (process.env.AI_ENDPOINT_REQUIRED_MODEL ?? "").trim() || required[0] || "";
  const completion = await requestWithTransientRetry(
    resolveCompletionsEndpoint(gatewayUrl),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: probeModel,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 96,
        stream: false,
      }),
    },
    { timeoutMs: 60_000, onRetry: retryNotice }
  );
  if (!completion.ok) {
    throw new CliError(
      `ERROR: AI endpoint inference probe for ${probeModel} returned HTTP ${completion.status}.`,
      65
    );
  }
  let completionBody: unknown;
  try {
    completionBody = JSON.parse(await completion.text()) as unknown;
  } catch {
    throw new CliError("ERROR: AI endpoint inference probe returned invalid JSON.", 65);
  }
  if (!completionHasText(completionBody)) {
    throw new CliError("ERROR: AI endpoint inference probe returned no usable response text.", 65);
  }
  console.log(
    `AI endpoint inference verified for ${probeModel}. Visible models: ${visible.join(", ")}.`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
