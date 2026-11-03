import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type MetricsWorkflow = {
  on?: Record<string, unknown>;
  jobs?: Record<string, { steps?: Array<{ name?: string; env?: Record<string, unknown> }> }>;
};

test("metrics aggregation never opens a PR directly after a release or PR dispatch", async () => {
  const workflow = parse(
    await readFile(".github/workflows/update-work-metrics.yml", "utf8")
  ) as MetricsWorkflow;
  const triggers = workflow.on ?? {};
  assert.equal("workflow_run" in triggers, false);
  assert.equal("repository_dispatch" in triggers, false);
  assert.deepEqual(triggers.schedule, [{ cron: "17 0 * * *" }]);
  const updateSteps = workflow.jobs?.update?.steps ?? [];
  assert.equal(updateSteps.some((step) => step.name === "Prepare incremental metrics"), false);
  const aggregate = updateSteps.find((step) => step.name === "Aggregate work metrics");
  assert.ok(aggregate);
  assert.equal("WORK_METRICS_JSON" in (aggregate.env ?? {}), false);
});
