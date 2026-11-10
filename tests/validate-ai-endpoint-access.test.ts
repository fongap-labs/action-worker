import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAiAgentConfig } from "../scripts/ai-agent-config.ts";
import {
  completionHasText,
  probeRetryDelayMs,
  requestWithTransientRetry,
  requiredPrAiModels,
  resolveCompletionsEndpoint,
  resolveModelsEndpoint,
  retryableProbeStatus,
  visibleModelIds,
} from "../scripts/validate-ai-endpoint-access.ts";

test("AI endpoint models endpoint follows configured base URL", () => {
  assert.equal(
    resolveModelsEndpoint("https://api.example.test"),
    "https://api.example.test/v1/models"
  );
  assert.equal(
    resolveModelsEndpoint("https://api.example.test/v1"),
    "https://api.example.test/v1/models"
  );
  assert.equal(
    resolveModelsEndpoint("https://api.example.test/v1/chat/completions"),
    "https://api.example.test/v1/models"
  );
});

test("AI endpoint preflight derives only enabled PR agent models", () => {
  const config = parseAiAgentConfig(
    JSON.stringify({
      schema_version: 1,
      agents: {
        triage: { enabled: true, model: "Code-Air" },
        review: {
          enabled: true,
          model: "Code-Pro",
          routes: {
            release: { model: "Code-Max" },
            deep: { model: "Code-Ultra" },
          },
        },
        writing: { enabled: true, model: "Pro" },
      },
    })
  );
  assert.deepEqual(requiredPrAiModels(config), ["Code-Air", "Code-Max", "Code-Pro", "Code-Ultra"]);
});

test("AI endpoint preflight includes an explicit bootstrap model when normal review is disabled", () => {
  const config = parseAiAgentConfig(
    JSON.stringify({
      schema_version: 1,
      agents: {
        review: { enabled: false, model: "Audit-Pro" },
        writing: { enabled: true, model: "Editor-Air" },
      },
    })
  );
  assert.deepEqual(requiredPrAiModels(config, "Editor-Air"), ["Editor-Air"]);
  assert.throws(() => requiredPrAiModels(config), /define no models/i);
});

test("AI endpoint preflight parses visible callable model ids", () => {
  assert.deepEqual(
    visibleModelIds({ data: [{ id: "Code-Pro" }, { id: "Code-Air" }, { id: "Code-Pro" }] }),
    ["Code-Air", "Code-Pro"]
  );
  assert.throws(() => visibleModelIds({ models: [] }));
});

test("AI endpoint completion probe uses the same OpenAI URL as OCR", () => {
  assert.equal(
    resolveCompletionsEndpoint("https://api.example.test/v1"),
    "https://api.example.test/v1/chat/completions"
  );
  assert.equal(
    resolveCompletionsEndpoint("https://api.example.test/v1/chat/completions"),
    "https://api.example.test/v1/chat/completions"
  );
  assert.equal(
    resolveCompletionsEndpoint("https://api.example.test"),
    "https://api.example.test/v1/chat/completions"
  );
});

test("AI endpoint inference probe requires actual response text", () => {
  assert.equal(completionHasText({ choices: [{ message: { content: "OK" } }] }), true);
  assert.equal(completionHasText({ choices: [{ message: { content: [{ text: "OK" }] } }] }), true);
  assert.equal(completionHasText({ choices: [{ message: { content: "" } }] }), false);
  assert.equal(completionHasText({ choices: [] }), false);
  assert.equal(completionHasText({ error: { message: "model unavailable" } }), false);
});

test("AI endpoint probe retries only transient HTTP statuses", () => {
  assert.equal(retryableProbeStatus(429), true);
  assert.equal(retryableProbeStatus(503), true);
  assert.equal(retryableProbeStatus(408), true);
  assert.equal(retryableProbeStatus(401), false);
  assert.equal(retryableProbeStatus(403), false);
  assert.equal(retryableProbeStatus(404), false);
  assert.equal(probeRetryDelayMs("3", 1), 3000);
  assert.equal(probeRetryDelayMs("300", 1), 30_000);
  assert.equal(probeRetryDelayMs(null, 2), 2000);
  assert.equal(probeRetryDelayMs("not-a-date", 2), 2000);
});

test("AI endpoint probe honors Retry-After and recovers after bounded 429 and 503", async () => {
  const responses = [
    new Response("", { status: 429, headers: { "retry-after": "3" } }),
    new Response("", { status: 503 }),
    new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }),
  ];
  const delays: number[] = [];
  const notices: string[] = [];
  let calls = 0;
  const response = await requestWithTransientRetry(
    "https://api.example.test/v1/chat/completions",
    { method: "POST", body: "probe", headers: { Authorization: "Bearer secret" } },
    {
      timeoutMs: 100,
      maxAttempts: 3,
      fetcher: async () => responses[calls++]!,
      wait: async (ms) => {
        delays.push(ms);
      },
      onRetry: (reason) => {
        notices.push(reason);
      },
    }
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [3000, 2000]);
  assert.deepEqual(notices, ["HTTP 429", "HTTP 503"]);
  assert.equal(completionHasText(await response.json()), true);
  assert.ok(notices.every((message) => !message.includes("secret")));
});

test("AI endpoint probe does not retry invalid credentials", async () => {
  let calls = 0;
  const response = await requestWithTransientRetry(
    "https://api.example.test/v1/models",
    {},
    {
      timeoutMs: 100,
      fetcher: async () => {
        calls += 1;
        return new Response("", { status: 401 });
      },
      wait: async () => {
        throw new Error("should not wait on HTTP 401");
      },
    }
  );
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test("AI endpoint probe exhausts 429 without claiming a successful review", async () => {
  let calls = 0;
  const response = await requestWithTransientRetry(
    "https://api.example.test/v1/models",
    {},
    {
      timeoutMs: 100,
      fetcher: async () => {
        calls += 1;
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      },
      wait: async () => undefined,
    }
  );
  assert.equal(response.status, 429);
  assert.equal(calls, 3);
});

test("AI endpoint probe limits connection error retries and preserves no provider body", async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(
    requestWithTransientRetry(
      "https://api.example.test/v1/models",
      {},
      {
        timeoutMs: 100,
        fetcher: async () => {
          calls += 1;
          throw new Error("Bearer secret-should-never-appear");
        },
        wait: async (ms) => {
          delays.push(ms);
        },
      }
    ),
    (error: unknown) =>
      error instanceof Error &&
      /failed to connect after bounded retries/.test(error.message) &&
      !error.message.includes("secret-should-never-appear")
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});
