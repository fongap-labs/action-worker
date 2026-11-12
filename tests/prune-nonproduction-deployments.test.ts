import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { nonProductionDeployments } from "../scripts/prune-nonproduction-deployments.ts";

test("deployment history pruning never selects production", () => {
  const created_at = "2026-11-01T00:00:00Z";
  assert.deepEqual(
    nonProductionDeployments([
      { id: 1, environment: "production", created_at },
      { id: 2, environment: "admin-ops", created_at },
      { id: 3, environment: "mcp-hub-ops", created_at },
      { id: 4, environment: "staging", created_at },
      { id: 5, environment: "any-future-environment", created_at },
    ]).map(({ id, environment }) => ({ id, environment })),
    [
      { id: 2, environment: "admin-ops" },
      { id: 3, environment: "mcp-hub-ops" },
      { id: 4, environment: "staging" },
      { id: 5, environment: "any-future-environment" },
    ]
  );
});

test("deployment history pruning rejects incomplete or malformed inventory", () => {
  for (const invalid of [
    null,
    {},
    [{ id: 0, environment: "admin-ops", created_at: "2026-11-01T00:00:00Z" }],
    [{ id: 1, environment: "", created_at: "2026-11-01T00:00:00Z" }],
    [{ id: 1, environment: "production" }],
  ]) {
    assert.throws(() => nonProductionDeployments(invalid));
  }
});

test("deployment backlog is automatically retried every thirty minutes without repeating daily maintenance", () => {
  const workflow = parse(readFileSync(".github/workflows/prune-stale-state.yml", "utf8")) as {
    on: { schedule: Array<{ cron: string }> };
    jobs: Record<string, { if?: string }>;
  };
  assert.deepEqual(workflow.on.schedule, [{ cron: "31 5 * * *" }, { cron: "17,47 * * * *" }]);
  assert.equal(
    workflow.jobs.deployments?.if,
    "${{ github.event_name == 'schedule' && github.event.schedule == '17,47 * * * *' }}"
  );
  const dailyOnly =
    "${{ github.event_name != 'schedule' || github.event.schedule == '31 5 * * *' }}";
  assert.equal(workflow.jobs.branches?.if, dailyOnly);
  assert.equal(workflow.jobs.runs?.if, dailyOnly);
});
