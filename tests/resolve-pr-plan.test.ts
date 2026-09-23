import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolvePlan,
  validateContext,
  type PlanOptions,
  type PlanPolicies,
} from "../scripts/resolve-pr-plan.ts";
import { parseAiAgentConfig } from "../scripts/ai-agent-config.ts";

const activeAiAgents = parseAiAgentConfig(JSON.stringify({
  schema_version: 1,
  agents: {
    triage: { enabled: true, model: "Code-Air" },
    review: {
      enabled: true,
      model: "Code-Pro",
      routes: {
        release: { model: "Code-Max" },
        security: { model: "Code-Ultra" },
        architecture: { model: "Code-Ultra" },
        deep: { model: "Code-Ultra" },
      },
    },
    writing: { enabled: true, model: "Pro" },
  },
}));

async function loadPolicies(aiAgents = activeAiAgents): Promise<PlanPolicies> {
  const load = async (name: string): Promise<unknown> => JSON.parse(
    await readFile(join(process.cwd(), "policies", `${name}.json`), "utf8"),
  ) as unknown;
  return {
    naming: await load("naming") as PlanPolicies["naming"],
    checks: await load("checks") as PlanPolicies["checks"],
    tests: await load("tests") as PlanPolicies["tests"],
    review: await load("review") as PlanPolicies["review"],
    triage: await load("triage") as PlanPolicies["triage"],
    execution: await load("execution") as PlanPolicies["execution"],
    aiAgents,
  };
}

const defaults: PlanOptions = {
  namingMode: "inherit",
  reviewMode: "inherit",
  blockOverride: "inherit",
  effortOverride: "inherit",
  modelOverride: "auto",
  agentOverride: "auto",
};

test("documentation changes keep review and CI disabled", async () => {
  const context = validateContext({
    project_types: ["node"],
    change_areas: ["documentation"],
    declared_impacts: [],
    risk: "low",
  });
  const plan = resolvePlan(context, await loadPolicies(), defaults);
  assert.deepEqual(plan.checks, ["naming"]);
  assert.deepEqual(plan.tests, []);
  assert.equal(plan.ci_required, false);
  assert.equal(plan.review_required, false);
  assert.equal(plan.review_agent, "none");
  assert.equal(plan.review_model, "");
  assert.equal(plan.triage_required, false);
});

test("workflow changes route through normal triage", async () => {
  const context = validateContext({
    project_types: ["github-automation"],
    change_areas: ["workflow"],
    declared_impacts: [],
    risk: "medium",
  });
  const plan = resolvePlan(context, await loadPolicies(), defaults);
  assert.deepEqual(plan.checks, ["actionlint", "naming"]);
  assert.equal(plan.ci_required, true);
  assert.equal(plan.review_agent, "workflow");
  assert.equal(plan.review_model, "Code-Pro");
  assert.equal(plan.review_effort, "low");
  assert.equal(plan.review_rule, "workflow.json");
  assert.equal(plan.review_task_timeout, 5);
  assert.equal(plan.review_resume_attempts, 3);
  assert.equal(plan.review_resume_backoff_seconds, 15);
  assert.equal(plan.triage_required, true);
  assert.equal(plan.triage_model, "Code-Air");
  assert.equal(plan.block_severity, "critical");
});

test("breaking and security routes preserve deterministic depth", async () => {
  const policies = await loadPolicies();
  const breaking = resolvePlan(validateContext({
    project_types: ["node"],
    change_areas: ["source", "release"],
    declared_impacts: ["breaking", "api", "compatibility"],
    risk: "high",
  }), policies, defaults);
  assert.equal(breaking.review_agent, "architecture");
  assert.equal(breaking.review_model, "Code-Ultra");
  assert.equal(breaking.review_task_timeout, 5);
  assert.equal(breaking.triage_required, false);
  assert.deepEqual(breaking.tests, ["api-test", "compatibility-test", "integration-test", "node-test"]);

  const security = resolvePlan(validateContext({
    project_types: ["node"],
    change_areas: ["script", "security"],
    declared_impacts: ["security"],
    risk: "high",
  }), policies, defaults);
  assert.equal(security.review_agent, "security");
  assert.equal(security.review_model, "Code-Ultra");
  assert.equal(security.review_task_timeout, 5);
  assert.equal(security.triage_required, false);
  assert.deepEqual(security.checks, ["naming", "secret-scan", "shellcheck"]);
});

test("disabled review agent skips AI while preserving deterministic CI", async () => {
  const context = validateContext({
    project_types: ["github-automation"],
    change_areas: ["workflow"],
    declared_impacts: [],
    risk: "medium",
  });
  const disabled = parseAiAgentConfig(JSON.stringify({
    schema_version: 1,
    agents: {
      triage: { enabled: true, model: "Code-Air" },
      review: { enabled: false, model: "Code-Pro" },
      writing: { enabled: true, model: "Pro" },
    },
  }));
  const plan = resolvePlan(context, await loadPolicies(disabled), defaults);
  assert.equal(plan.ci_required, true);
  assert.equal(plan.review_required, false);
  assert.equal(plan.review_agent, "none");
  assert.equal(plan.review_model, "");
  assert.equal(plan.triage_required, false);
});

test("explicit overrides keep the existing CLI semantics", async () => {
  const context = validateContext({
    project_types: ["node"],
    change_areas: ["source", "release"],
    declared_impacts: ["breaking"],
    risk: "high",
  });
  const plan = resolvePlan(context, await loadPolicies(), {
    namingMode: "off",
    reviewMode: "on",
    blockOverride: "critical",
    effortOverride: "low",
    modelOverride: "Code-Air",
    agentOverride: "code",
  });
  assert.equal(plan.naming_required, false);
  assert.equal(plan.review_agent, "code");
  assert.equal(plan.review_model, "Code-Air");
  assert.equal(plan.triage_required, true);
  assert.equal(plan.block_severity, "critical");
});
