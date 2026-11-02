import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAiAgentConfig } from "../scripts/ai-agent-config.ts";
import {
  completionHasText,
  requiredPrAiModels,
  resolveCompletionsEndpoint,
  resolveModelsEndpoint,
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
