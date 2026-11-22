import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { requiredCiJobsPassed } from "../scripts/ci-required-jobs.ts";

test("declared Windows must succeed; only undeclared Windows may be skipped", () => {
  assert.equal(requiredCiJobsPassed("success", "success", "success", "true"), true);
  assert.equal(requiredCiJobsPassed("success", "success", "skipped", "false"), true);
  for (const state of ["skipped", "failure", "cancelled", "", "pending"]) {
    assert.equal(requiredCiJobsPassed("success", "success", state, "true"), false);
  }
  assert.equal(requiredCiJobsPassed("success", "success", "success", "false"), false);
  for (const required of ["", "TRUE", "unknown"]) {
    assert.equal(requiredCiJobsPassed("success", "success", "success", required), false);
  }
});

test("missing, failed or skipped mandatory Linux and Security block the final gate", () => {
  for (const bad of ["failure", "skipped", "cancelled", "", "pending"]) {
    assert.equal(requiredCiJobsPassed(bad, "success", "success", "true"), false);
    assert.equal(requiredCiJobsPassed("success", bad, "success", "true"), false);
  }
});

test("CI finalization actually invokes the strict verdict helper", () => {
  const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
  const finalize = workflow.slice(
    workflow.indexOf("  finalize:"),
    workflow.indexOf("  prepare-failure:")
  );
  assert.match(finalize, /HAS_WINDOWS: \$\{\{ needs\.prepare\.outputs\.has_windows \}\}/);
  assert.match(finalize, /if node scripts\/ci-required-jobs\.ts/);
});
