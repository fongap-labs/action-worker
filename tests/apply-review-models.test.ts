import assert from "node:assert/strict";
import { test } from "node:test";
import { aiAgentModel, enabledAiModels, parseAiAgentConfig } from "../scripts/ai-agent-config.ts";
import {
  applyReviewModels,
  hasAuditCode,
  parseReviewModelPolicy,
  reportReviewVariableError,
} from "../scripts/apply-review-models.ts";
import { CliError } from "../scripts/runtime-command.ts";

const policy = { schema_version: 1, model: "Audit-Code" };

test("AI Review policy allows only Audit-Code without tiers", () => {
  assert.deepEqual(parseReviewModelPolicy(policy), policy);
  assert.throws(() => parseReviewModelPolicy({ ...policy, model: "Audit-Pro" }));
  assert.throws(() => parseReviewModelPolicy({ ...policy, routes: { security: "Audit-Max" } }));
});

test("AI Review and enabled PR triage use Audit-Code; other agents stay unchanged", () => {
  const current = JSON.stringify({
    schema_version: 1,
    agents: {
      triage: { enabled: true, model: "Audit-Pro" },
      review: {
        enabled: true,
        model: "Audit-Pro",
        routes: {
          security: { model: "Audit-Ultra" },
          release: { model: "Audit-Max" },
        },
      },
      writing: { enabled: true, model: "Editor-Air" },
    },
  });
  const updated = JSON.parse(applyReviewModels(current, policy));
  assert.deepEqual(updated.agents.writing, {
    enabled: true,
    model: "Editor-Air",
    routes: {},
  });
  const config = parseAiAgentConfig(JSON.stringify(updated));
  assert.deepEqual(enabledAiModels(config, ["triage", "review"]), ["Audit-Code"]);
  for (const route of ["code", "workflow", "release", "security", "architecture", "deep"]) {
    assert.equal(aiAgentModel(config, "review", route), "Audit-Code");
  }
  assert.equal(aiAgentModel(config, "triage"), "Audit-Code");
});

test("disabled triage remains disabled", () => {
  const initial = JSON.stringify({
    schema_version: 1,
    agents: { triage: { enabled: false }, writing: { enabled: true, model: "Editor-Air" } },
  });
  const config = parseAiAgentConfig(applyReviewModels(initial, policy));
  assert.equal(config.agents.triage?.enabled, false);
  assert.equal(aiAgentModel(config, "review", "security"), "Audit-Code");
});

test("model preflight recognizes Audit-Code only", () => {
  assert.equal(hasAuditCode({ data: [{ id: "Audit-Code" }] }), true);
  assert.equal(hasAuditCode({ data: [{ id: "Audit-Max" }, { id: "Audit-Pro" }] }), false);
  assert.equal(hasAuditCode({ data: [] }), false);
  assert.equal(hasAuditCode({ error: "unauthorized" }), false);
});

test("GitHub variable permission failures identify the required admin token scope", () => {
  for (const operation of ["read", "update"] as const) {
    assert.throws(
      () =>
        reportReviewVariableError(
          new CliError("gh: Resource not accessible by personal access token (HTTP 403)"),
          "fongap-labs/action-worker",
          operation
        ),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 65 &&
        error.message.includes(`Cannot ${operation} GitHub Actions variable AW_AI_AGENT_CONFIG`) &&
        error.message.includes("AW_ADMIN_TOKEN") &&
        error.message.includes("Variables: Read and write")
    );
  }
});

test("other GitHub variable errors preserve the original failure", () => {
  const original = new CliError("gh: Not Found (HTTP 404)", 1);
  assert.throws(
    () => reportReviewVariableError(original, "fongap-labs/action-worker", "read"),
    (error) => error === original
  );
});
