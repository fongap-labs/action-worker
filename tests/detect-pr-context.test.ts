import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  changeAreaForPath,
  listChangedFiles,
} from "../scripts/detect-pr-context.ts";

const exec = promisify(execFile);

test("deleted workflow files remain part of PR context", async () => {
  const root = await mkdtemp(join(tmpdir(), "action-worker-pr-context-"));
  try {
    await exec("git", ["init", "-q"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    const workflow = join(root, ".github", "workflows", "legacy.yml");
    await writeFile(workflow, "name: Legacy\n", "utf8");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "base"], { cwd: root });
    const { stdout: base } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    await rm(workflow);
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "delete workflow"], { cwd: root });
    const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    const changed = await listChangedFiles(base.trim(), head.trim(), root);
    assert.deepEqual(changed, [".github/workflows/legacy.yml"]);
    assert.equal(
      changeAreaForPath(changed[0]!, [".github/workflows/"], "CHANGELOG.md"),
      "workflow",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
