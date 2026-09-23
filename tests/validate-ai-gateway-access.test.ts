import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requiredPrAiModels,
  resolveModelsEndpoint,
  visibleModelIds,
} from "../scripts/validate-ai-gateway-access.ts";
import { parseAiAgentConfig } from "../scripts/ai-agent-config.ts";

test("AI Gateway models endpoint follows configured base URL", () => {
  assert.equal(resolveModelsEndpoint("https://api.example.test"), "https://api.example.test/v1/models");
  assert.equal(resolveModelsEndpoint("https://api.example.test/v1"), "https://api.example.test/v1/models");
  assert.equal(resolveModelsEndpoint("https://api.example.test/v1/chat/completions"), "https://api.example.test/v1/models");
});

test("AI Gateway preflight derives only enabled PR agent models", () => {
  const config = parseAiAgentConfig(JSON.stringify({
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
  }));
  assert.deepEqual(requiredPrAiModels(config), ["Code-Air", "Code-Max", "Code-Pro", "Code-Ultra"]);
});

test("AI Gateway preflight parses visible callable model ids", () => {
  assert.deepEqual(
    visibleModelIds({ data: [{ id: "Code-Pro" }, { id: "Code-Air" }, { id: "Code-Pro" }] }),
    ["Code-Air", "Code-Pro"],
  );
  assert.throws(() => visibleModelIds({ models: [] }));
});
