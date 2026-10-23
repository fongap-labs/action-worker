import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const centralCi = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
const taskDispatch = readFileSync(".github/workflows/handle-task-dispatch.yml", "utf8");

test("a cancelled central CI run writes no CI Evidence verdict over the run that replaces it", () => {
  const finalize = centralCi.slice(
    centralCi.indexOf("  finalize:"),
    centralCi.indexOf("  prepare-failure:")
  );
  const guard = finalize.indexOf('"$LINUX_RESULT" == "cancelled"');
  const write = finalize.indexOf("gh api --method POST");
  assert.notEqual(guard, -1, "finalize checks for a cancelled run");
  assert.notEqual(write, -1, "finalize still publishes CI Evidence for completed runs");
  assert.ok(guard < write, "the cancelled check runs before the status is written");
  const guarded = finalize.slice(guard, write);
  assert.match(guarded, /exit 0/, "a cancelled run exits without failing");
});

test("a publication pull request is never closed by the publish step", () => {
  assert.doesNotMatch(taskDispatch, /gh pr close/);
  assert.doesNotMatch(taskDispatch, /--delete-branch/);
});

test("the publish step ends on a validate-merge failure only after repeated reads", () => {
  const failure = taskDispatch.slice(
    taskDispatch.indexOf("                  failure)"),
    taskDispatch.indexOf("                  *)\n                      failure_reads=0")
  );
  assert.match(failure, /failure_reads=\$\(\( \$\{failure_reads:-0\} \+ 1 \)\)/);
  assert.match(failure, /-ge 3/, "the publication ends after three consecutive failure reads");
  assert.match(failure, /failed the validate-merge check/);
  assert.match(
    taskDispatch,
    /\*\)\n\s+failure_reads=0/,
    "any other state resets the failure count"
  );
});
