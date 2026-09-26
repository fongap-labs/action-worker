import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");

test("main CI dispatches do not cancel the same immutable head", () => {
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event\.action == 'run-central-ci' \}\}/,
  );
});

test("main CI reuses successful evidence before heavy jobs", () => {
  assert.match(
    workflow,
    /select\(\.context == "CI Evidence"\)/,
  );
  assert.match(
    workflow,
    /should_run: \$\{\{ steps\.ref_facts\.outputs\.should_run \|\| 'true' \}\}/,
  );
  assert.match(
    workflow,
    /Central CI \/ Linux[\s\S]*?if: needs\.prepare\.outputs\.should_run != 'false'/,
  );
  assert.match(
    workflow,
    /Central CI \/ Security[\s\S]*?if: needs\.prepare\.outputs\.should_run != 'false'/,
  );
  assert.match(
    workflow,
    /Publish Central CI[\s\S]*?needs\.prepare\.outputs\.should_run != 'false'/,
  );
});
