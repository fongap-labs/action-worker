import assert from "node:assert/strict";
import { test } from "node:test";
import { aiAgentModel, enabledAiModels, parseAiAgentConfig } from "../scripts/ai-agent-config.ts";
import { applyReviewModels, parseReviewModelPolicy } from "../scripts/apply-review-models.ts";

const policy = {
  schema_version: 1,
  models: ["Audit-Pro", "Audit-Max"],
  review: {
    enabled: true,
    model: "Audit-Pro",
    routes: {
      code: { model: "Audit-Pro" },
      workflow: { model: "Audit-Pro" },
      release: { model: "Audit-Max" },
      security: { model: "Audit-Max" },
      architecture: { model: "Audit-Max" },
      deep: { model: "Audit-Max" },
    },
  },
};

test("review policy permits only the two configured review models", () => {
  assert.deepEqual(parseReviewModelPolicy(policy).models, ["Audit-Pro", "Audit-Max"]);
  assert.throws(() =>
    parseReviewModelPolicy({
      ...policy,
      review: {
        ...policy.review,
        routes: { ...policy.review.routes, security: { model: "Audit-Ultra" } },
      },
    })
  );
  assert.throws(() =>
    parseReviewModelPolicy({
      ...policy,
      review: { ...policy.review, routes: { code: { model: "Audit-Pro" } } },
    })
  );
});

test("review model sync preserves unrelated agents and removes Ultra from review", () => {
  const current = JSON.stringify({
    schema_version: 1,
    agents: {
      triage: { enabled: true, model: "Audit-Pro" },
      review: {
        enabled: true,
        model: "Audit-Pro",
        routes: { security: { model: "Audit-Ultra" } },
      },
      writing: { enabled: true, model: "Editor-Air" },
    },
  });
  const updated = JSON.parse(applyReviewModels(current, policy));
  assert.deepEqual(updated.agents.triage, { enabled: true, model: "Audit-Pro" });
  assert.deepEqual(updated.agents.writing, { enabled: true, model: "Editor-Air" });
  const config = parseAiAgentConfig(JSON.stringify(updated));
  assert.deepEqual(enabledAiModels(config, ["triage", "review"]), ["Audit-Max", "Audit-Pro"]);
  assert.equal(aiAgentModel(config, "review", "code"), "Audit-Pro");
  assert.equal(aiAgentModel(config, "review", "security"), "Audit-Max");
  assert.equal(aiAgentModel(config, "review", "architecture"), "Audit-Max");
  assert.equal(aiAgentModel(config, "review", "release"), "Audit-Max");
});
