import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  artifactKey,
  buildTaskStateManifest,
  openBytes,
  openStateFile,
  restoreTaskState,
  sealBytes,
  sealedStateFile,
  sealStateDirectory,
  taskLogView,
  taskStateArtifactName,
  taskStateManifestFile,
  taskStateManifestMatches,
  trustedStateRuns,
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
  assert.match(workflow, /node scripts\/task-state\.ts restore /);
  assert.match(workflow, /node scripts\/task-state\.ts seal-state /);
  assert.match(workflow, /node scripts\/task-state\.ts seal-log /);
  assert.doesNotMatch(workflow, /gh run list/);
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

const sealKey = Buffer.alloc(32, 7);

test("a sealed artifact opens only with its key, kind, repository and project", () => {
  const plain = Buffer.from("private task output", "utf8");
  const sealed = sealBytes(sealKey, "task-log", "o/r", "p", plain);
  assert.equal(sealed.includes(plain), false, "the plain text does not appear in the sealed file");
  assert.deepEqual(openBytes(sealKey, "task-log", "o/r", "p", sealed), plain);
  for (const [key, kind, repository, project] of [
    [Buffer.alloc(32, 8), "task-log", "o/r", "p"],
    [sealKey, "task-state", "o/r", "p"],
    [sealKey, "task-log", "o/other", "p"],
    [sealKey, "task-log", "o/r", "q"],
  ] as const) {
    assert.throws(() => openBytes(key, kind, repository, project, sealed), /does not belong/);
  }
  assert.throws(() => artifactKey("c2hvcnQ="), /32 bytes/);
});

test("sealed task state round-trips through a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-seal-"));
  try {
    const source = join(root, "source");
    await writeTaskStateManifest(source, "o/r", "p", "a".repeat(40));
    await writeFile(join(source, "cursor.txt"), "42\n", "utf8");
    const sealedFile = join(root, sealedStateFile);
    await sealStateDirectory(sealKey, source, "o/r", "p", sealedFile);
    const opened = join(root, "opened");
    await openStateFile(sealKey, sealedFile, "o/r", "p", opened);
    assert.equal(await readFile(join(opened, "cursor.txt"), "utf8"), "42\n");
    assert.equal(await verifyTaskStateDirectory(opened, "o/r", "p"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function artifactReader(runs: Record<number, Record<string, unknown>>) {
  return {
    async get(path: string): Promise<unknown> {
      if (path.includes("/actions/artifacts?name=")) {
        return {
          artifacts: Object.keys(runs).map((id) => ({
            expired: false,
            workflow_run: { id: Number(id) },
          })),
        };
      }
      const id = Number(path.split("/").pop());
      return runs[id];
    },
  };
}

const taskRun = {
  path: ".github/workflows/handle-task-dispatch.yml",
  head_branch: "main",
  conclusion: "success",
};

test("task state is restored only from a successful run of the task workflow on main", async () => {
  const reader = artifactReader({
    1: { ...taskRun, path: ".github/workflows/validate-ci.yml" },
    2: { ...taskRun, head_branch: "feature" },
    3: { ...taskRun, conclusion: "failure" },
    4: taskRun,
  });
  assert.deepEqual(await trustedStateRuns(reader, "o/aw", "task-state-x"), [4]);
});

test("a private task source restores only sealed state, and nothing without the key", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-restore-"));
  try {
    const plainState = join(root, "plain");
    await writeTaskStateManifest(plainState, "o/r", "p", "a".repeat(40));
    const sealedState = join(root, "sealed");
    await mkdir(sealedState, { recursive: true });
    await sealStateDirectory(sealKey, plainState, "o/r", "p", join(sealedState, sealedStateFile));
    const reader = artifactReader({ 5: taskRun });
    const restore = (source: string, key: Buffer | null) =>
      restoreTaskState({
        stateRoot: join(root, "state"),
        repository: "o/r",
        project: "p",
        isPrivate: true,
        key,
        reader,
        controlRepository: "o/aw",
        download: async (_runId, _name, destination) => {
          await cp(source, destination, { recursive: true });
        },
      });

    assert.match(await restore(sealedState, null), /needs AW_ARTIFACT_KEY/);
    assert.equal(await restore(plainState, sealKey), "No previous task state found.");
    assert.equal(await restore(sealedState, sealKey), "Restored task state from run 5.");
    assert.equal(await verifyTaskStateDirectory(join(root, "state", "previous"), "o/r", "p"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
