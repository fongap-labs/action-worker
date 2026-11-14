import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBaseChangelog, addedUnreleasedEntries } from "../scripts/validate-change-record.ts";

test("first CHANGELOG addition is valid but an unchanged missing file is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-changelog-init-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "README.md"), "bootstrap\n");
    git("add", ".");
    git("commit", "-qm", "chore: bootstrap");
    const base = git("rev-parse", "HEAD");
    const headContent = "# 更新日志\n\n## [Unreleased]\n\n- 修复: 初始化变更记录\n";
    writeFileSync(join(root, "CHANGELOG.md"), headContent);
    git("add", ".");
    git("commit", "-qm", "fix: add changelog");
    const head = git("rev-parse", "HEAD");
    const baseline = await readBaseChangelog(root, base, head, "CHANGELOG.md");
    assert.deepEqual(addedUnreleasedEntries(baseline, headContent), [
      "- 修复: 初始化变更记录",
    ]);
    await assert.rejects(readBaseChangelog(root, base, base, "CHANGELOG.md"), /must be an added file/);
    assert.equal(await readBaseChangelog(root, head, head, "CHANGELOG.md"), headContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
