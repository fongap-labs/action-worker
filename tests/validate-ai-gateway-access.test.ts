import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requiredAiModels,
  resolveModelsEndpoint,
  visibleModelIds,
} from "../scripts/validate-ai-gateway-access.ts";

test("AI Gateway models endpoint follows configured base URL", () => {
  assert.equal(resolveModelsEndpoint("https://api.example.test"), "https://api.example.test/v1/models");
  assert.equal(resolveModelsEndpoint("https://api.example.test/v1"), "https://api.example.test/v1/models");
  assert.equal(resolveModelsEndpoint("https://api.example.test/v1/chat/completions"), "https://api.example.test/v1/models");
});

test("AI Gateway preflight derives all directly used governance models", () => {
  const triage = { model: "Code-Air", deep_model: "Code-Ultra" };
  const review = {
    agents: {
      code: { model: "Code-Pro" },
      workflow: { model: "Code-Pro" },
      release: { model: "Code-Pro" },
      security: { model: "Code-Ultra" },
      architecture: { model: "Code-Ultra" },
    },
  };
  assert.deepEqual(requiredAiModels(triage, review), ["Code-Air", "Code-Pro", "Code-Ultra"]);
});

test("AI Gateway preflight parses visible callable model ids", () => {
  assert.deepEqual(
    visibleModelIds({ data: [{ id: "Code-Pro" }, { id: "Code-Air" }, { id: "Code-Pro" }] }),
    ["Code-Air", "Code-Pro"],
  );
  assert.throws(() => visibleModelIds({ models: [] }));
});
