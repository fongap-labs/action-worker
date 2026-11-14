import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addedUnreleasedEntries, readBaseChangelog } from "../scripts/validate-change-record.ts";
import { runText } from "../scripts/runtime-command.ts";

const policy = { changelog_heading: "# 更新日志", unreleased_heading: "## [Unreleased]" };

test("first added changelog preserves policy checks and forbids release baselines", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "changelog-first-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Synthetic"],
    ["config", "user.email", ["test", "example.invalid"].join("@")],
  ]) {
    await runText("git", args, { cwd: root });
  }
  await writeFile(join(root, "README.md"), "Base\n");
  await runText("git", ["add", "."], { cwd: root });
  await runText("git", ["commit", "-qm", "base"], { cwd: root });
  const base = await runText("git", ["rev-parse", "HEAD"], { cwd: root });
  const headContent = "# 更新日志\n\n## [Unreleased]\n\n- 修复: 首次建立规范变更记录\n";
  await writeFile(join(root, "CHANGELOG.md"), headContent);
  await runText("git", ["add", "."], { cwd: root });
  await runText("git", ["commit", "-qm", "add changelog"], { cwd: root });
  const head = await runText("git", ["rev-parse", "HEAD"], { cwd: root });
  const baseline = await readBaseChangelog(root, base, head, "CHANGELOG.md", policy, true);
  assert.deepEqual(addedUnreleasedEntries(baseline, headContent), ["- 修复: 首次建立规范变更记录"]);
  await assert.rejects(readBaseChangelog(root, base, head, "CHANGELOG.md", policy, false));
  await assert.rejects(readBaseChangelog(root, base, base, "CHANGELOG.md", policy, true));
  await assert.rejects(readBaseChangelog(root, base, head, "CHANGELOG.md", {}, true));
  const existing = await readBaseChangelog(root, head, head, "CHANGELOG.md", policy, true);
  assert.match(existing, /Unreleased/);
});
