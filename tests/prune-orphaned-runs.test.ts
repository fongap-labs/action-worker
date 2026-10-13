import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  gracePeriodMs,
  isDeletableRun,
  isPastGracePeriod,
  maxDeletionsPerRun,
  orphanedWorkflows,
} from "../scripts/prune-orphaned-runs.ts";

test("only workflow files missing from main are orphaned", () => {
  const listed = {
    workflows: [
      { id: 1, name: "Intake", path: ".github/workflows/intake.yml" },
      { id: 2, name: "PR Intake", path: ".github/workflows/pr-intake.yml" },
      { id: 3, name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates" },
      { id: 4, name: "Broken", path: "../outside.yml" },
    ],
  };
  const onMain = new Set([".github/workflows/intake.yml"]);
  assert.deepEqual(
    orphanedWorkflows(listed, (path) => onMain.has(path)),
    [{ id: 2, name: "PR Intake", path: ".github/workflows/pr-intake.yml" }]
  );
});

test("a removed workflow keeps its runs during the grace period", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const recent = { updated_at: new Date(now - gracePeriodMs + 60_000).toISOString() };
  const old = { updated_at: new Date(now - gracePeriodMs - 60_000).toISOString() };
  assert.equal(isPastGracePeriod(recent, now), false);
  assert.equal(isPastGracePeriod(old, now), true);
  assert.equal(isPastGracePeriod({}, now), false);
});

test("only completed runs are deleted, within the token's hourly budget", () => {
  assert.equal(isDeletableRun({ id: 7, status: "completed" }), true);
  assert.equal(isDeletableRun({ id: 7, status: "in_progress" }), false);
  assert.equal(isDeletableRun({ status: "completed" }), false);
  assert.ok(maxDeletionsPerRun < 1000);
});

test("the prune workflow deletes runs with the workflow token from a checkout of main", async () => {
  const workflow = await readFile(".github/workflows/prune-stale-state.yml", "utf8");
  const runs = workflow.slice(workflow.indexOf("  runs:"));
  assert.match(runs, /permissions:\n\s+actions: write\n\s+contents: read\n/);
  assert.match(runs, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(runs, /secrets\./);
  const script = await readFile("scripts/prune-orphaned-runs.ts", "utf8");
  assert.match(script, /GITHUB_REF !== "refs\/heads\/main"/);
  assert.match(script, /The running workflow file is not in this checkout/);
});
