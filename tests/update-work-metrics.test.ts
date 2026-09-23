import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyIncrement,
  mapWithLimit,
  isSuccessfulRun,
  parseFixture,
  renderMetrics,
} from "../scripts/update-work-metrics.ts";

const source = `# Action Worker

<!-- work-metrics:start -->
old
<!-- work-metrics:end -->
`;

test("metrics rendering preserves badge order and is idempotent", () => {
  const counts = parseFixture(
    '{"dispatch":7,"pr_governance":12,"ai_review":9,"gate":12,"release_governance":3}',
  );
  const rendered = renderMetrics(source, counts, "fongap/action-worker");
  assert.match(rendered, /Task%20Dispatch-7-4B6F8C/);
  assert.match(rendered, /PR%20Governance-12-3F5A78/);
  assert.match(rendered, /AI%20Review-9-7A6853/);
  const order = ["Task%20Dispatch-", "AI%20Review-", "PR%20Governance-", "Release%20Governance-", "Status"];
  const positions = order.map((token) => rendered.indexOf(token));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.equal(renderMetrics(rendered, counts, "fongap/action-worker"), rendered);
  assert.equal(renderMetrics(source.replaceAll("\n", "\r\n"), counts, "fongap/action-worker").includes("\r"), false);
});

test("Task Dispatch counts only successful Handle Task Dispatch repository runs", () => {
  const path = ".github/workflows/handle-task-dispatch.yml";
  assert.equal(isSuccessfulRun({
    path,
    event: "repository_dispatch",
    conclusion: "success",
  }, path), true);
  assert.equal(isSuccessfulRun({
    path,
    event: "repository_dispatch",
    conclusion: "failure",
  }, path), false);
  assert.equal(isSuccessfulRun({
    path,
    event: "push",
    conclusion: "success",
  }, path), false);
  assert.equal(isSuccessfulRun({
    path: ".github/workflows/handle-pr-dispatch.yml",
    event: "repository_dispatch",
    conclusion: "success",
  }, path), false);
});

test("metrics jobs use bounded concurrency and preserve result order", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  await assert.rejects(() => mapWithLimit([1], 0, async (value) => value));
});

test("increment mode reads the current badges and derives the gate count", () => {
  const current = renderMetrics(source, {
    dispatch: 7,
    pr_governance: 12,
    ai_review: 9,
    gate: 12,
    release_governance: 3,
  }, "fongap/action-worker");
  assert.deepEqual(applyIncrement(current, {
    dispatch: 1,
    pr_governance: 1,
    ai_review: 1,
    release_governance: 0,
  }), {
    dispatch: 8,
    pr_governance: 13,
    ai_review: 10,
    gate: 13,
    release_governance: 3,
  });
});

test("fixture counts reject fractional or negative values", () => {
  assert.throws(() => parseFixture(
    '{"dispatch":1.5,"pr_governance":0,"ai_review":0,"gate":0,"release_governance":0}',
  ));
  assert.throws(() => parseFixture(
    '{"dispatch":-1,"pr_governance":0,"ai_review":0,"gate":0,"release_governance":0}',
  ));
});
