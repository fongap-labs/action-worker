import assert from "node:assert/strict";
import { test } from "node:test";
import {
  metricIncrementForWorkflow,
  updateMetricsChangelog,
} from "../scripts/manage-work-metrics.ts";

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

test("metrics updates add a normal unreleased chore entry with stable section spacing", () => {
  const timestamp = "2026-11-19T01:18:21.000Z";
  const base = "# 更新日志\n\n## [Unreleased]\n\n## [1.0.0]\n";
  const expectedEntry = `- 维护: 更新工作指标数据（${timestamp}）。`;
  const updated = updateMetricsChangelog(base, timestamp);
  assert.equal(
    updated,
    `# 更新日志\n\n## [Unreleased]\n\n${expectedEntry}\n\n## [1.0.0]\n`
  );
  assert.equal(updateMetricsChangelog(updated, timestamp), updated);

  const existing =
    "# 更新日志\n\n## [Unreleased]\n\n- 维护: 保留已有记录。\n\n\n## [1.0.0]\n";
  assert.equal(
    updateMetricsChangelog(existing, timestamp),
    `# 更新日志\n\n## [Unreleased]\n\n- 维护: 保留已有记录。\n${expectedEntry}\n\n## [1.0.0]\n`
  );

  assert.equal(
    updateMetricsChangelog("# 更新日志\n\n## [Unreleased]\n", timestamp),
    `# 更新日志\n\n## [Unreleased]\n\n${expectedEntry}\n`
  );
  assert.throws(() => updateMetricsChangelog(base, "not-a-timestamp"));
  assert.throws(() => updateMetricsChangelog(base, "2026-99-99T25:99:99.999Z"));
  assert.throws(() => updateMetricsChangelog("# 更新日志\n", timestamp));
});
