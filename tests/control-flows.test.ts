import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildComparison } from "../scripts/build-review-comparison.ts";
import { detectContext } from "../scripts/detect-pr-context.ts";
import { runText } from "../scripts/runtime-command.ts";
import { addedUnreleasedEntries, validateChange } from "../scripts/validate-change-record.ts";

const policyDir = resolve("policies");

async function git(root: string, args: readonly string[]): Promise<string> {
  return await runText("git", args, { cwd: root });
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "action-worker-test-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  return root;
}

test("change record requires concise Chinese entries in CHANGELOG.md", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  const initial = "# 更新日志\n\n## [Unreleased]\n";
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await writeFile(join(root, "CHANGELOG.md"), initial, "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);

  await writeFile(join(root, "README.md"), "# Fixture\n\nMore docs.\n", "utf8");
  await writeFile(
    join(root, "CHANGELOG.md"),
    initial + "\n- 维护: 更新安装说明。\n",
    "utf8"
  );
  await git(root, ["add", "README.md", "CHANGELOG.md"]);
  await git(root, ["commit", "-qm", "docs"]);
  const docsHead = await git(root, ["rev-parse", "HEAD"]);
  assert.equal(
    (await validateChange("chore: clarify setup", base, docsHead, root, policyDir)).type,
    "chore"
  );
  await assert.rejects(validateChange("docs: clarify setup", base, docsHead, root, policyDir));
  await assert.rejects(validateChange("feat: add feature", base, docsHead, root, policyDir));

  async function commitEntry(content: string, message: string): Promise<string> {
    await git(root, ["reset", "--hard", "-q", base]);
    await rm(join(root, "changelog.d"), { recursive: true, force: true });
    await writeFile(join(root, "CHANGELOG.md"), content, "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", message]);
    return git(root, ["rev-parse", "HEAD"]);
  }

  const featureHead = await commitEntry(initial + "\n- 新增: 增加示例能力。\n", "direct entry");
  const feature = await validateChange(
    "feat(core): add example capability",
    base,
    featureHead,
    root,
    policyDir
  );
  assert.equal(feature.scope, "core");
  assert.equal(feature.changelog_changed, true);

  for (const entry of [
    "- 新增: add example capability.",
    "- 修复: 修复示例能力。",
    "- 安全: 收紧示例能力。",
    "- 新增: " + "优化配置和执行流程".repeat(11) + "。",
  ]) {
    const head = await commitEntry(initial + "\n" + entry + "\n", "bad entry");
    await assert.rejects(
      validateChange("feat(core): add example capability", base, head, root, policyDir),
      entry
    );
  }

  const duplicateHead = await commitEntry(
    initial + "\n- 新增: 增加示例能力。\n- 新增: 增加示例能力。\n",
    "duplicate entry"
  );
  await assert.rejects(validateChange("feat: add feature", base, duplicateHead, root, policyDir));

  await git(root, ["reset", "--hard", "-q", base]);
  await mkdir(join(root, "changelog.d"), { recursive: true });
  await writeFile(join(root, "changelog.d", "legacy.md"), "- 新增: 旧片段。\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "legacy fragment"]);
  const fragmentHead = await git(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    validateChange("feat: add feature", base, fragmentHead, root, policyDir),
    "changelog.d files must be rejected"
  );

  const seeded = await commitEntry(initial + "\n- 修复: 修复旧问题。\n", "seed old entry");
  const edited = await commitEntry(
    initial + "\n- 修复: 修改旧问题。\n- 新增: 增加示例能力。\n",
    "edit old entry"
  );
  await assert.rejects(
    validateChange("feat: add feature", seeded, edited, root, policyDir),
    "existing entries cannot be rewritten"
  );
});

test("CHANGELOG preface may change without rewriting published versions", () => {
  const released = "\n## [0.1.0]\n\n### 修复\n\n- 旧版修复。\n";
  const before = "# Changelog\n\nLegacy fragment notes.\n\n## [Unreleased]\n" + released;
  const after = "# 更新日志\n\n## [Unreleased]\n\n- 修复: 修复新版问题。\n" + released;
  assert.deepEqual(addedUnreleasedEntries(before, after), ["- 修复: 修复新版问题。"]);
  assert.throws(
    () => addedUnreleasedEntries(before, after.replace("旧版修复。", "改写旧版修复。")),
    /must not modify released/
  );
});

test("retiring fragments allows removing obsolete preface but preserves released versions", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  const released = "\n## [0.1.0]\n\n### 修复\n\n- 旧版修复。\n";
  const previous =
    "# Changelog\n\nLegacy fragments live in changelog.d.\n\n## [Unreleased]\n" + released;
  await writeFile(join(root, "CHANGELOG.md"), previous, "utf8");
  await mkdir(join(root, "changelog.d"));
  await writeFile(join(root, "changelog.d", "fix.md"), "- 修复: 修复新版问题。\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  const headText = "# 更新日志\n\n## [Unreleased]\n\n- 修复: 修复新版问题。\n" + released;
  await writeFile(join(root, "CHANGELOG.md"), headText, "utf8");
  await git(root, ["rm", "-q", "changelog.d/fix.md"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "retire fragments"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const validated = await validateChange(
    "fix: repair changelog migration",
    base,
    head,
    root,
    policyDir
  );
  assert.equal(validated.type, "fix");

  await writeFile(join(root, "CHANGELOG.md"), headText.replace("旧版修复。", "改写旧版修复。"));
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "tamper with history"]);
  const changed = await git(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    validateChange("fix: repair changelog migration", base, changed, root, policyDir),
    /preserve published sections/
  );
});

test("context detection classifies workflow and declared impacts", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(join(root, ".github", "workflows", "release.yml"), "name: Release\n", "utf8");
  await writeFile(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n- Breaking API migration affecting deployment compatibility.\n",
    "utf8"
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "head"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const result = await detectContext(base, head, root, policyDir);
  assert.deepEqual(result.project_types, ["github-automation"]);
  assert.ok(result.change_areas.includes("workflow"));
  assert.ok(result.change_areas.includes("documentation"));
  assert.equal(result.change_areas.includes("release"), false);
  for (const impact of ["breaking", "api", "migration", "deployment", "compatibility"]) {
    assert.ok(result.declared_impacts.includes(impact));
  }
  assert.equal(result.risk, "high");
});

test("review comparison injects evidence without changing the reviewed diff", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "base\n", "utf8");
  await git(root, ["add", "source.txt"]);
  await git(root, ["commit", "-qm", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "source.txt"), "head\n", "utf8");
  await git(root, ["add", "source.txt"]);
  await git(root, ["commit", "-qm", "head"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(
    join(root, ".action-worker-ci-evidence.json"),
    '{"conclusion":"success"}\n',
    "utf8"
  );
  const comparison = await buildComparison(root, base, head, ".action-worker-ci-evidence.json");
  assert.equal(
    await git(root, ["show", `${comparison.base_sha}:.action-worker-ci-evidence.json`]),
    '{"conclusion":"success"}'
  );
  assert.equal(
    await git(root, ["show", `${comparison.head_sha}:.action-worker-ci-evidence.json`]),
    '{"conclusion":"success"}'
  );
  assert.equal(
    await git(root, ["diff", "--name-only", comparison.base_sha, comparison.head_sha]),
    "source.txt"
  );
});
