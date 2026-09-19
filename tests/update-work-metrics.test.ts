import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyIncrement,
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
    '{"dispatch":1411,"pr_governance":12,"ai_review":9,"gate":12,"release_governance":3}',
  );
  const rendered = renderMetrics(source, counts, "fongap/action-worker");
  assert.match(rendered, /Dispatch-1%2C411-2F80ED/);
  assert.match(rendered, /PR%20Governance-12-6366F1/);
  assert.match(rendered, /AI%20Review-9-8B5CF6/);
  const order = ["Dispatch-", "AI%20Review-", "PR%20Governance-", "Release%20Governance-", "Status"];
  const positions = order.map((token) => rendered.indexOf(token));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.equal(renderMetrics(rendered, counts, "fongap/action-worker"), rendered);
  assert.equal(renderMetrics(source.replaceAll("\n", "\r\n"), counts, "fongap/action-worker").includes("\r"), false);
});

test("increment mode reads the current badges and derives the gate count", () => {
  const current = renderMetrics(source, {
    dispatch: 1411,
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
    dispatch: 1412,
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
