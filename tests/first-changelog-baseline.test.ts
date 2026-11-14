import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addedUnreleasedEntries, readBaseChangelog } from "../scripts/validate-change-record.ts";

test("first CHANGELOG addition is valid but an unchanged missing file is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-changelog-init-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "fixture-identity");
    writeFileSync(join(root, "README.md"), "bootstrap\n");
    git("add", ".");
    git("commit", "-qm", "chore: bootstrap");
    const base = git("rev-parse", "HEAD");
    const headContent = "# \u66f4\u65b0\u65e5\u5fd7\n\n## [Unreleased]\n\n- \u4fee\u590d: \u521d\u59cb\u5316\u53d8\u66f4\u8bb0\u5f55\n";
    writeFileSync(join(root, "CHANGELOG.md"), headContent);
    git("add", ".");
    git("commit", "-qm", "fix: add changelog");
    const head = git("rev-parse", "HEAD");
    const baseline = await readBaseChangelog(root, base, head, "CHANGELOG.md");
    assert.deepEqual(addedUnreleasedEntries(baseline, headContent), [
      "- \u4fee\u590d: \u521d\u59cb\u5316\u53d8\u66f4\u8bb0\u5f55",
    ]);
    await assert.rejects(readBaseChangelog(root, base, base, "CHANGELOG.md"), /must be an added file/);
    assert.equal(await readBaseChangelog(root, head, head, "CHANGELOG.md"), headContent.trimEnd());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
