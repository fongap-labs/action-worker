import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

test("work metrics only runs on a daily schedule, never on release completion", async () => {
  const content = await readFile(
    new URL("../.github/workflows/update-work-metrics.yml", import.meta.url),
    "utf8"
  );
  const workflow = parse(content) as {
    on: Record<string, unknown>;
    jobs: { update: { steps: Array<{ env?: Record<string, string> }> } };
  };
  assert.deepEqual(Object.keys(workflow.on), ["schedule"]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "17 0 * * *" }]);
  assert.equal(content.includes("workflow_run"), false);
  assert.equal(content.includes("WORK_METRICS_JSON:"), false);
  assert.equal(content.includes("SOURCE_RUN_ID:"), false);
  const steps = workflow.jobs.update.steps as Array<{
    name?: string;
    run?: string;
    env?: Record<string, string>;
  }>;
  const wait = steps.find((step) => step.run === "node scripts/manage-work-metrics.ts ci");
  assert.equal(wait?.env?.PR_NUMBER, "${{ steps.pr.outputs.number }}");
  assert.equal(steps.some((step) => step.run === "node scripts/manage-work-metrics.ts merge"), false);
  const manager = await readFile("scripts/manage-work-metrics.ts", "utf8");
  assert.match(manager, /Metrics PR was not automatically merged from its verified CI head/);
  assert.doesNotMatch(manager, /async function mergePull/);
});
