import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runText } from "../scripts/runtime-command.ts";
import { addedUnreleasedEntries, readBaseChangelog } from "../scripts/validate-change-record.ts";

const policy = { changelog_heading: "# \u66f4\u65b0\u65e5\u5fd7", unreleased_heading: "## [Unreleased]" };

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
  const headContent = "# \u66f4\u65b0\u65e5\u5fd7\n\n## [Unreleased]\n\n- \u4fee\u590d: \u9996\u6b21\u5efa\u7acb\u89c4\u8303\u53d8\u66f4\u8bb0\u5f55\n";
  await writeFile(join(root, "CHANGELOG.md"), headContent);
  await runText("git", ["add", "."], { cwd: root });
  await runText("git", ["commit", "-qm", "add changelog"], { cwd: root });
  const head = await runText("git", ["rev-parse", "HEAD"], { cwd: root });
  const baseline = await readBaseChangelog(root, base, head, "CHANGELOG.md", policy, true);
  assert.deepEqual(addedUnreleasedEntries(baseline, headContent), ["- \u4fee\u590d: \u9996\u6b21\u5efa\u7acb\u89c4\u8303\u53d8\u66f4\u8bb0\u5f55"]);
  await assert.rejects(readBaseChangelog(root, base, head, "CHANGELOG.md", policy, false));
  await assert.rejects(readBaseChangelog(root, base, base, "CHANGELOG.md", policy, true));
  await assert.rejects(readBaseChangelog(root, base, head, "CHANGELOG.md", {}, true));
  const existing = await readBaseChangelog(root, head, head, "CHANGELOG.md", policy, true);
  assert.match(existing, /Unreleased/);
});
