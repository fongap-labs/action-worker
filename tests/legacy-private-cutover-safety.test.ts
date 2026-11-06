import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { writeTaskStateManifest } from "../scripts/task-state.ts";

test("untrusted legacy state cannot overwrite or redirect the trusted manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-legacy-state-"));
  try {
    const current = join(root, "current");
    await mkdir(current);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "untouched");
    await symlink(outside, join(current, "manifest.json"));
    await assert.rejects(
      writeTaskStateManifest(current, "fongap-labs/example", "sample", "a".repeat(40)),
      /EEXIST/
    );
    assert.equal(await readFile(outside, "utf8"), "untouched");
    await rm(join(current, "manifest.json"));
    await writeFile(join(current, "manifest.json"), "forged");
    await assert.rejects(
      writeTaskStateManifest(current, "fongap-labs/example", "sample", "a".repeat(40)),
      /EEXIST/
    );
    assert.equal(await readFile(join(current, "manifest.json"), "utf8"), "forged");
    await symlink(current, join(root, "alias"));
    await assert.rejects(
      writeTaskStateManifest(join(root, "alias"), "fongap-labs/example", "sample", "a".repeat(40)),
      /trusted directory/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy task state is not saved after failed task execution or on skipped tasks", async () => {
  const raw = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(raw) as {
    jobs: Record<string, { steps?: Array<{ name?: string; if?: string; env?: Record<string, string> }> }>;
  };
  const steps = workflow.jobs.execute?.steps ?? [];
  const find = (name: string) => steps.find((step) => step.name === name);
  assert.equal(find("Write task state manifest")?.if, "steps.task.outcome == 'success'");
  assert.equal(find("Seal task state")?.if, "steps.task.outcome == 'success'");
  assert.equal(
    find("Upload task state")?.if,
    "steps.task.outcome == 'success' && steps.state_upload.outputs.path != ''"
  );
  assert.match(find("Restore previous task state")?.env?.AW_ARTIFACT_KEY ?? "", /is_private == 'true'/);
  assert.match(find("Seal task state")?.env?.AW_ARTIFACT_KEY ?? "", /is_private == 'true'/);
  assert.doesNotMatch(
    find("Restore previous task state")?.env?.AW_ARTIFACT_KEY ?? "",
    /^\$\{\{ secrets\.AW_ARTIFACT_KEY \}\}$/
  );
});
