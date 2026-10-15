import assert from "node:assert/strict";
import { test } from "node:test";
import { metricIncrementForWorkflow } from "../scripts/manage-work-metrics.ts";

test("work metrics increment every completed governance surface", () => {
  assert.deepEqual(metricIncrementForWorkflow("自动 · 任务分发"), {
    dispatch: 1,
    pr_governance: 0,
    ai_review: 0,
    release_governance: 0,
  });
  assert.deepEqual(metricIncrementForWorkflow("自动 · PR 分发", false), {
    dispatch: 0,
    pr_governance: 1,
    ai_review: 0,
    release_governance: 0,
  });
  assert.deepEqual(metricIncrementForWorkflow("自动 · PR 分发", true), {
    dispatch: 0,
    pr_governance: 1,
    ai_review: 1,
    release_governance: 0,
  });
  assert.deepEqual(metricIncrementForWorkflow("自动 · 发布分发"), {
    dispatch: 0,
    pr_governance: 0,
    ai_review: 0,
    release_governance: 1,
  });
  assert.throws(() => metricIncrementForWorkflow("Unknown Workflow"));
});
