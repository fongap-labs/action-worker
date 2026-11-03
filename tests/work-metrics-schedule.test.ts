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
});
