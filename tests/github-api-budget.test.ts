import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import {
  evaluateGithubCoreBudget,
  parseGithubApiReserve,
} from "../scripts/check-github-api-budget.ts";

const quota = (remaining: number, limit = 5000, reset = 1800000000): unknown => ({
  resources: { core: { remaining, limit, reset } },
});

test("optional scans defer when core API remaining reaches the reserved budget", () => {
  const decision = evaluateGithubCoreBudget(quota(300));
  assert.equal(decision.run, false);
  assert.equal(decision.remaining, 300);
  assert.equal(decision.limit, 5000);
  assert.equal(decision.reserve, 300);
  assert.equal(decision.reset_at, new Date(1800000000 * 1000).toISOString());
  assert.equal(evaluateGithubCoreBudget(quota(0)).run, false);
  assert.equal(evaluateGithubCoreBudget(quota(299)).run, false);
  assert.equal(evaluateGithubCoreBudget(quota(301)).run, true);
});

test("quota preflight fails closed for missing, invalid or misleading quota data", () => {
  for (const response of [
    {},
    { rate: { remaining: 4000, limit: 5000, reset: 1800000000 } },
    { resources: { core: { remaining: -1, limit: 5000, reset: 1800000000 } } },
    { resources: { core: { remaining: 5001, limit: 5000, reset: 1800000000 } } },
    { resources: { core: { remaining: "5000", limit: 5000, reset: 1800000000 } } },
    { resources: { core: { remaining: 5000, limit: 5000, reset: 0 } } },
  ]) {
    assert.throws(() => evaluateGithubCoreBudget(response), /quota response is invalid/);
  }
  assert.throws(() => evaluateGithubCoreBudget(quota(100), 0), /reserve must be/);
});

test("quota reserve must be a bounded positive integer", () => {
  assert.equal(parseGithubApiReserve("300"), 300);
  for (const invalid of ["", "0", "-1", "01", "30.0", "100000", "abc"]) {
    assert.throws(() => parseGithubApiReserve(invalid), /reserve must be/);
  }
});

test("only optional intake jobs defer; important CI and governance continue", async () => {
  const source = await readFile(".github/workflows/intake.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<string, { steps: Array<{ name?: string; id?: string; run?: string; if?: string; env?: Record<string, string> }> }>;
  };
  for (const job of ["task-sources", "task-schedules", "deploy-schedules"]) {
    const steps = workflow.jobs[job]?.steps ?? [];
    const preflight = steps.find((step) => step.id === "api_budget");
    assert.equal(preflight?.run, "node scripts/check-github-api-budget.ts");
    assert.equal(preflight?.env?.AW_API_QUOTA_RESERVE, "300");
    assert.equal(preflight?.env?.AW_CONTROL_TOKEN, "${{ steps.control_read_app.outputs.token }}");
    assert.ok(
      steps.some((step) => step.if === "steps.api_budget.outputs.run == 'true'"),
      `${job} must defer only the optional scan step`
    );
  }
  for (const job of ["pull-requests", "main-ci", "main-writes"]) {
    const steps = workflow.jobs[job]?.steps ?? [];
    assert.equal(steps.some((step) => step.id === "api_budget"), false, job);
  }
});
