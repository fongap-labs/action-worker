import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const cleanup = readFileSync(".github/workflows/cancel-pr-work.yml", "utf8");
const governance = readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8");
const ci = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");

test("abandoned PR cleanup uses the exact running governance concurrency key", () => {
  const expected = "pr-governance-" + "$" + "{{ needs.validate.outputs.repository }}-" +
    "$" + "{{ needs.validate.outputs.pr_number }}";
  assert.ok(cleanup.includes(expected));
  assert.match(governance, /group: pr-governance-/);
  assert.doesNotMatch(cleanup, /group: pr-governance-[^\n]*head_sha/);
});

test("central CI cleanup uses the pinned head and preserves merged revisions", () => {
  const expected = "central-ci-" + "$" + "{{ needs.validate.outputs.repository }}-" +
    "$" + "{{ needs.validate.outputs.head_sha }}";
  assert.ok(cleanup.includes(expected));
  assert.match(ci, /group: central-ci-\$\{\{ github\.event\.client_payload\.repository \}\}-\$\{\{ github\.event\.client_payload\.head_sha \}\}/);
  const section = cleanup.slice(cleanup.indexOf("  central-ci:"));
  assert.match(section, /if: needs\.validate\.outputs\.merged != 'true'/);
  assert.match(section, /cancel-in-progress: true/);
});
