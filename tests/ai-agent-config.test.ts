import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiAgentModel,
  enabledAiModels,
  isAiAgentEnabled,
  parseAiAgentConfig,
} from "../scripts/ai-agent-config.ts";

test("empty AI agent config disables all optional agents", () => {
  const config = parseAiAgentConfig("");
  assert.deepEqual(config, { schema_version: 1, agents: {} });
  assert.equal(isAiAgentEnabled(config, "review"), false);
  assert.deepEqual(enabledAiModels(config), []);
});

test("AI agent config supports independent capabilities and routed models", () => {
  const config = parseAiAgentConfig(JSON.stringify({
    schema_version: 1,
    agents: {
      triage: { enabled: true, model: "Code-Air" },
      review: {
        enabled: false,
        model: "Code-Pro",
        routes: {
          release: { model: "Code-Max" },
          security: { model: "Code-Ultra" },
          deep: { model: "Code-Ultra" },
        },
      },
      writing: { enabled: true, model: "Pro" },
    },
  }));

  assert.equal(isAiAgentEnabled(config, "triage"), true);
  assert.equal(isAiAgentEnabled(config, "review"), false);
  assert.equal(isAiAgentEnabled(config, "writing"), true);
  assert.equal(aiAgentModel(config, "triage"), "Code-Air");
  assert.equal(aiAgentModel(config, "writing"), "Pro");
  assert.deepEqual(enabledAiModels(config), ["Code-Air", "Pro"]);
  assert.deepEqual(enabledAiModels(config, ["triage", "review"]), ["Code-Air"]);
  assert.throws(() => aiAgentModel(config, "review", "release"));
});

test("enabled routed review falls back to its default model", () => {
  const config = parseAiAgentConfig(JSON.stringify({
    schema_version: 1,
    agents: {
      review: {
        enabled: true,
        model: "Code-Pro",
        routes: {
          release: { model: "Code-Max" },
          deep: { model: "Code-Ultra" },
        },
      },
    },
  }));

  assert.equal(aiAgentModel(config, "review", "code"), "Code-Pro");
  assert.equal(aiAgentModel(config, "review", "release"), "Code-Max");
  assert.equal(aiAgentModel(config, "review", "deep"), "Code-Ultra");
});

test("AI agent config remains strict when an enabled agent has no model", () => {
  assert.throws(() => parseAiAgentConfig(JSON.stringify({
    schema_version: 1,
    agents: {
      review: { enabled: true },
    },
  })));
  assert.throws(() => parseAiAgentConfig(JSON.stringify({
    schema_version: 1,
    agents: {
      "Bad Agent": { enabled: false },
    },
  })));
});
