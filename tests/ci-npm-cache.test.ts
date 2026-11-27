import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/validate-ci.yml", "utf8");
const contract = workflow.slice(
  workflow.indexOf("  contracts:"),
  workflow.indexOf("  private-sandbox-integration:")
);
const staticJob = workflow.slice(workflow.indexOf("  static:"), workflow.indexOf("  contracts:"));

test("CI contract job reuses trusted lockfile-scoped npm cache", () => {
  assert.match(contract, /uses: actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);
  assert.match(contract, /node-version: \$\{\{ steps\.runtime\.outputs\.node \}\}\s+cache: npm/);
  assert.match(staticJob, /node-version: \$\{\{ steps\.runtime\.outputs\.node \}\}\s+cache: npm/);
  assert.doesNotMatch(contract, /restore-keys:/);
});

test("npm cache does not replace any contract verification or install", () => {
  assert.match(contract, /run: npm ci/);
  assert.match(contract, /run: npm test/);
  assert.match(contract, /run: python3 tests\/test-source-naming\.py/);
  assert.doesNotMatch(contract, /cache-hit/);
  const aggregate = workflow.slice(workflow.indexOf("  validate-merge:"));
  assert.match(aggregate, /needs:\s+- change-governance/);
  assert.match(aggregate, /\s+- contracts\s+/);
});
