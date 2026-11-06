import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const workflowDirectory = ".github/workflows";
const controllerFile = "handle-task-dispatch.yml";
const stateWritePattern =
  /(?:node\s+scripts\/task-state\.ts\s+(?:write|seal-state)\b|steps\.state_upload\.outputs\.path)/;

test("only the task controller may contain known task-state write operations", async () => {
  const files = (await readdir(workflowDirectory)).filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.length > 1, "Workflow inventory must not be empty");
  const observedWriters: string[] = [];
  for (const file of files) {
    const content = await readFile(join(workflowDirectory, file), "utf8");
    if (stateWritePattern.test(content)) observedWriters.push(file);
  }
  assert.deepEqual(observedWriters, [controllerFile]);
});

test("the task controller retains lifecycle serialization across all task modes", async () => {
  const content = await readFile(join(workflowDirectory, controllerFile), "utf8");
  assert.match(
    content,
    /^concurrency:\n  group: aw-task-lifecycle:\$\{\{ github\.event\.client_payload\.repository \}\}:\$\{\{ github\.event\.client_payload\.project \}\}\n  cancel-in-progress: false/m
  );
  assert.match(content, /node scripts\/task-state\.ts restore /);
  assert.match(content, /node scripts\/task-state\.ts seal-state /);
  assert.match(content, /steps\.private_isolation\.outputs\.enabled/);
});

test("task-source dispatcher does not create another task-state writer", async () => {
  const content = await readFile(
    join(workflowDirectory, "task-source-dispatch.yml"),
    "utf8"
  );
  assert.match(content, /event_type: "run-task"/);
  assert.doesNotMatch(content, stateWritePattern);
});
