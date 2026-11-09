import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

test("PR review publisher receives the signing key for verifying central merge gates", async () => {
  const source = await readFile(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const workflow = parse(source) as Workflow;
  const publishers = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.run?.includes("scripts/publish-pr-review.ts"));
  assert.equal(publishers.length, 1, "exactly one PR review publication step");
  const publisher = publishers[0];
  assert.equal(publisher?.env?.AW_STATUS_KEYRING, "${{ secrets.AW_STATUS_KEYRING }}");
  assert.equal(publisher?.env?.AW_STATUS_API_TOKEN, "${{ steps.final_status_app.outputs.token }}");
  assert.equal(publisher?.env?.AW_CONTROL_TOKEN, "${{ steps.final_read_app.outputs.token }}");
  assert.equal(publisher?.env?.HEAD_SHA, "${{ steps.resolved.outputs.head_sha }}");
});
