import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTaskStateManifest,
  taskLogView,
  taskStateArtifactName,
  taskStateManifestFile,
  taskStateManifestMatches,
  verifyTaskStateDirectory,
  writeTaskStateManifest,
} from "../scripts/task-state.ts";

test("task state artifact names are distinct for every repository and project pair", () => {
  // The old scheme mapped all of these to "task-state-fongap-labs-a-b-c".
  const names = new Set([
    taskStateArtifactName("fongap-labs/a-b", "c"),
    taskStateArtifactName("fongap-labs/a", "b-c"),
    taskStateArtifactName("fongap-labs/a/b", "c"),
  ]);
  assert.equal(names.size, 3);
  assert.match(taskStateArtifactName("o/r", "p"), /^task-state-[0-9a-f]{32}$/);
  assert.equal(taskStateArtifactName("o/r", "p"), taskStateArtifactName("o/r", "p"));
  assert.notEqual(taskStateArtifactName("o/r", "p"), taskStateArtifactName("o/r", "q"));
  assert.notEqual(taskStateArtifactName("o/r", "p"), taskStateArtifactName("o/s", "p"));
});

test("the artifact name is not derived from the readable names", () => {
  const name = taskStateArtifactName("fongap-labs/internal-vault", "MarketBrief");
  assert.equal(name.includes("internal"), false);
  assert.equal(name.includes("MarketBrief"), false);
});

test("empty values and NUL are refused", () => {
  assert.throws(() => taskStateArtifactName("", "p"));
  assert.throws(() => taskStateArtifactName("o/r", ""));
  assert.throws(() => taskStateArtifactName("o/r\0x", "p"));
  assert.throws(() => buildTaskStateManifest("o/r", "p\0", "a".repeat(40)));
});

test("a manifest matches only its own repository and project", () => {
  const raw = JSON.stringify(buildTaskStateManifest("o/r", "p", "a".repeat(40)));
  assert.equal(taskStateManifestMatches(raw, "o/r", "p"), true);
  assert.equal(taskStateManifestMatches(raw, "o/r", "q"), false);
  assert.equal(taskStateManifestMatches(raw, "o/s", "p"), false);
  assert.equal(taskStateManifestMatches("not json", "o/r", "p"), false);
  assert.equal(taskStateManifestMatches("[]", "o/r", "p"), false);
  assert.equal(taskStateManifestMatches("{}", "o/r", "p"), false);
});

test("a state directory is accepted when its manifest matches and ignored otherwise", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "task-state-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await verifyTaskStateDirectory(directory, "o/r", "p"), false, "no manifest yet");
  await writeTaskStateManifest(directory, "o/r", "p", "b".repeat(40));
  assert.equal(await verifyTaskStateDirectory(directory, "o/r", "p"), true);
  assert.equal(await verifyTaskStateDirectory(directory, "o/r", "other"), false);
  const written = JSON.parse(await readFile(join(directory, taskStateManifestFile), "utf8"));
  assert.deepEqual(written, { repository: "o/r", project: "p", bootstrap_ref: "b".repeat(40) });
  await writeFile(join(directory, taskStateManifestFile), "{broken", "utf8");
  assert.equal(await verifyTaskStateDirectory(directory, "o/r", "p"), false);
});

test("private task sources show only short hashes in the public log", () => {
  const values = {
    project: "MarketBrief",
    ref: "0123456789abcdef0123456789abcdef01234567",
    requestId: "task-schedule-marketbrief-2026-10-07",
  };
  const view = taskLogView(true, values);
  assert.match(view.project, /^sha256:[0-9a-f]{8}$/);
  assert.match(view.requestId, /^sha256:[0-9a-f]{8}$/);
  assert.equal(view.ref, "0123456");
  const text = JSON.stringify(view);
  assert.equal(text.includes("MarketBrief"), false);
  assert.equal(text.includes(values.ref), false);
  assert.equal(text.includes(values.requestId), false);
  assert.deepEqual(taskLogView(true, values), view, "stable, so runs can be correlated");
});

test("public task sources keep the readable values", () => {
  const values = { project: "Blog", ref: "c".repeat(40), requestId: "req-1" };
  assert.deepEqual(taskLogView(false, values), values);
});

test("the task workflow uses the hashed artifact name, the manifest and the log view", async () => {
  const workflow = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  assert.match(workflow, /node scripts\/task-state\.ts name /);
  assert.match(workflow, /node scripts\/task-state\.ts verify /);
  assert.match(workflow, /node scripts\/task-state\.ts write /);
  assert.match(workflow, /node scripts\/task-state\.ts log-view /);
  const echoed = workflow
    .split("\n")
    .filter((line) => /^\s*echo\s+"(?:Request ID|Project|Bootstrap Ref)\s*:/.test(line));
  assert.equal(echoed.length, 6, "three fields in each of the two log groups");
  for (const line of echoed) {
    assert.match(line, /\$\{log_(?:request_id|project|ref)\}/, line);
    assert.equal(/\$\{(?:REQUEST_ID|PROJECT|BOOTSTRAP_REF)\}/.test(line), false, line);
  }
});
