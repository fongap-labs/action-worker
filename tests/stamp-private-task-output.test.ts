import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { stampPrivateTaskOutput } from "../scripts/stamp-private-task-output.ts";

const repository = "fongap-labs/example";
const project = "sample";
const sha = "a".repeat(40);

test("successful isolated output gets a fresh, exclusive identity manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-private-output-"));
  try {
    const current = join(root, "current");
    await mkdir(current);
    await writeFile(join(current, "cursor.txt"), "42");
    await stampPrivateTaskOutput(current, repository, project, sha);
    const data = JSON.parse(await readFile(join(current, "manifest.json"), "utf8")) as Record<
      string,
      string
    >;
    assert.deepEqual(data, { repository, project, bootstrap_ref: sha });
    assert.equal(await readFile(join(current, "cursor.txt"), "utf8"), "42");
    await assert.rejects(stampPrivateTaskOutput(current, repository, project, sha), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malicious links and forged manifests cannot overwrite trusted state or escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-private-output-"));
  try {
    const current = join(root, "current");
    await mkdir(current);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "sentinel");
    await symlink(outside, join(current, "manifest.json"));
    await assert.rejects(
      stampPrivateTaskOutput(current, repository, project, sha),
      /symbolic links/
    );
    assert.equal(await readFile(outside, "utf8"), "sentinel");
    await rm(join(current, "manifest.json"));
    await writeFile(join(current, "manifest.json"), '{"bootstrap_ref":"forged"}');
    await assert.rejects(stampPrivateTaskOutput(current, repository, project, sha), /EEXIST/);
    assert.equal(
      await readFile(join(current, "manifest.json"), "utf8"),
      '{"bootstrap_ref":"forged"}'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated private workflow only seals recoverable state after successful bootstrap", async () => {
  const raw = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(raw) as {
    jobs: Record<
      string,
      {
        steps?: Array<{
          id?: string;
          name?: string;
          if?: string;
          run?: string;
          uses?: string;
        }>;
      }
    >;
  };
  const task = workflow.jobs.run_private_isolated?.steps ?? [];
  const trusted = workflow.jobs.finalize_private_isolated?.steps ?? [];
  const stamp = task.find((step) => step.name === "Stamp and encrypt private task state");
  const log = task.find((step) => step.name === "Encrypt private task log before leaving Runner");
  const finalize = trusted.find(
    (step) => step.name === "Validate and seal historical private state and log"
  );
  const upload = trusted.find((step) => step.name === "Upload encrypted historical private state");
  assert.equal(stamp?.if, "steps.private_bootstrap.outcome == 'success'");
  assert.match(stamp?.run ?? "", /stamp-private-task-output\.ts/);
  assert.doesNotMatch(stamp?.run ?? "", /task-state\.ts write/);
  assert.match(log?.if ?? "", /always\(\)/);
  assert.match(finalize?.run ?? "", /state_file=""/);
  assert.match(finalize?.run ?? "", /TASK_OUTCOME.*success/);
  assert.match(finalize?.run ?? "", /log\.seal/);
  assert.equal(upload?.if, "env.TASK_OUTCOME == 'success'");
  assert.equal(
    task.some((step) => step.uses?.includes("upload-artifact") && step.if?.includes("always()")),
    true
  );
});
