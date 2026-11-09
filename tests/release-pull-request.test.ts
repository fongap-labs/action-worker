import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertReleaseChange,
  assertScopedReleaseChange,
  entriesFromLines,
  promoteEntries,
  promoteUnreleased,
  releaseSectionBody,
} from "../scripts/changelog-release.ts";
import {
  assertMergedReleaseSection,
  assertReleasePullRequestIdentity,
  assertReleaseStageDeadline,
  isExactChangelogResumeDiff,
  releasePullRequestTitle,
  releaseStageTiming,
} from "../scripts/changelog-release-pr.ts";
import { runText } from "../scripts/runtime-command.ts";
import { validateChange } from "../scripts/validate-change-record.ts";

const policyDir = resolve("policies");
const categories = ["新增", "修复", "维护"];
const releaseUrl = "https://github.com/fongap-labs/example/releases/tag/example-v0.2.0";
const base =
  "# 更新日志\n\n## [Unreleased]\n\n- 修复: 修正超时。\n\n## [0.1.0](https://github.com/fongap-labs/example/releases/tag/example-v0.1.0) - 2026-10-01\n\n### 修复\n\n- 旧条目。\n";

function releaseOf(changelog: string): string {
  return promoteUnreleased(changelog, {
    version: "0.2.0",
    date: "2026-10-23",
    releaseUrl,
    categories,
  });
}

test("invalid stage-one poll and timeout fail before any PR mutation", () => {
  assert.deepEqual(releaseStageTiming({}, 1_000), {
    pollMs: 20_000,
    deadline: 1_801_000,
  });
  assert.deepEqual(releaseStageTiming({ pollSeconds: 5, timeoutMinutes: 2 }, 1_000), {
    pollMs: 5_000,
    deadline: 121_000,
  });
  for (const invalid of [
    { pollSeconds: 0 },
    { pollSeconds: 121 },
    { pollSeconds: 1.5 },
    { timeoutMinutes: 0 },
    { timeoutMinutes: 31 },
    { timeoutMinutes: Number.NaN },
  ]) {
    assert.throws(
      () => releaseStageTiming(invalid),
      /Release poll and timeout settings are invalid/
    );
  }
});

test("stage-one deadline is shared by merge and post-merge guard checks", () => {
  assert.doesNotThrow(() => assertReleaseStageDeadline(2_000, 1_999));
  const cases: Array<[number, number]> = [
    [2_000, 2_000],
    [2_000, 2_001],
    [Number.NaN, 1_000],
    [2_000, Number.POSITIVE_INFINITY],
  ];
  for (const [deadline, now] of cases) {
    assert.throws(
      () => assertReleaseStageDeadline(deadline, now),
      /Two-phase release deadline expired/
    );
  }
});

test("stale staging source may resume only an exact CHANGELOG-only squash successor", () => {
  const originalSha = "a".repeat(40);
  const mergedSha = "b".repeat(40);
  const exact = {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    base_commit: { sha: originalSha },
    commits: [{ sha: mergedSha }],
    files: [{ filename: "CHANGELOG.md", status: "modified" }],
  };
  assert.equal(isExactChangelogResumeDiff(exact, originalSha, mergedSha, "CHANGELOG.md"), true);
  for (const changed of [
    { status: "diverged" },
    { ahead_by: 2 },
    { behind_by: 1 },
    { base_commit: { sha: "c".repeat(40) } },
    { commits: [{ sha: "c".repeat(40) }] },
    { commits: [...exact.commits, { sha: "c".repeat(40) }] },
    { files: [] },
    { files: [{ filename: "scripts/unsafe.ts", status: "modified" }] },
    { files: [{ filename: "CHANGELOG.md", status: "added" }] },
    {
      files: [...exact.files, { filename: "scripts/unsafe.ts", status: "modified" }],
    },
    { files: undefined },
  ]) {
    assert.equal(
      isExactChangelogResumeDiff({ ...exact, ...changed }, originalSha, mergedSha, "CHANGELOG.md"),
      false
    );
  }
  assert.equal(isExactChangelogResumeDiff(null, originalSha, mergedSha, "CHANGELOG.md"), false);
});

test("a resumable release PR must match its tag, source and protected base", () => {
  const options = {
    repository: "fongap-labs/example",
    defaultBranch: "main",
    tag: "example-v0.2.0",
  };
  const valid = {
    number: 27,
    title: "chore(release): example-v0.2.0",
    draft: false,
    merged: true,
    head: { ref: "aw/changelog/example-v0.2.0", repo: { full_name: "fongap-labs/example" } },
    base: { ref: "main", repo: { full_name: "fongap-labs/example" } },
  };
  assert.doesNotThrow(() => assertReleasePullRequestIdentity(valid, options));
  for (const mutation of [
    { title: "chore(release): other-v0.2.0" },
    { number: 0 },
    { draft: true },
    { head: { ...valid.head, ref: "unrelated" } },
    { head: { ...valid.head, repo: { full_name: "attacker/example" } } },
    { base: { ...valid.base, ref: "unprotected" } },
    { base: { ...valid.base, repo: { full_name: "attacker/example" } } },
  ]) {
    assert.throws(
      () => assertReleasePullRequestIdentity({ ...valid, ...mutation }, options),
      /Existing release PR identity does not match/
    );
  }
  assert.throws(() => assertReleasePullRequestIdentity(null, options));
});

test("release changes must promote exactly the existing entries", () => {
  const head = releaseOf(base);
  assert.deepEqual(assertReleaseChange({ baseChangelog: base, headChangelog: head, categories }), {
    version: "0.2.0",
    releaseUrl,
    date: "2026-10-23",
  });
  assert.throws(
    () =>
      assertReleaseChange({
        baseChangelog: base,
        headChangelog: head.replace("修正超时", "改变超时"),
        categories,
      }),
    /does not match/
  );
  assert.throws(
    () =>
      assertReleaseChange({
        baseChangelog: base,
        headChangelog: head + "\n## [0.0.9](https://example.invalid/v0.0.9) - 2026-09-01\n",
        categories,
      }),
    /exactly one version section/
  );
});

test("release sections contain categorized entries", () => {
  assert.equal(releaseSectionBody(releaseOf(base), releaseUrl), "### 修复\n\n- 修正超时。");
  assert.throws(
    () => releaseSectionBody(releaseOf(base), "https://example.invalid/other"),
    /has no section/
  );
  assert.equal(releasePullRequestTitle("example-v0.2.0"), "chore(release): example-v0.2.0");
});

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "action-worker-release-pr-"));
  await runText("git", ["init", "-q"], { cwd: root });
  await runText("git", ["config", "user.name", "Test"], { cwd: root });
  await runText("git", ["config", "user.email", "test@example.com"], { cwd: root });
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await runText("git", ["add", "."], { cwd: root });
  await runText("git", ["commit", "-qm", message], { cwd: root });
  return runText("git", ["rev-parse", "HEAD"], { cwd: root });
}

test("release PRs can change only CHANGELOG.md", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await writeFile(join(root, "CHANGELOG.md"), base, "utf8");
  const baseSha = await commit(root, "base");
  const title = releasePullRequestTitle("example-v0.2.0");
  await writeFile(join(root, "CHANGELOG.md"), releaseOf(base), "utf8");
  const releaseSha = await commit(root, "release");
  const record = await validateChange(title, baseSha, releaseSha, root, policyDir);
  assert.equal(record.type, "chore");
  assert.equal(record.changelog_changed, true);

  await runText("git", ["reset", "--hard", "-q", baseSha], { cwd: root });
  await writeFile(join(root, "CHANGELOG.md"), releaseOf(base), "utf8");
  await writeFile(join(root, "README.md"), "# Changed\n", "utf8");
  const illegalSha = await commit(root, "release with extra file");
  await assert.rejects(validateChange(title, baseSha, illegalSha, root, policyDir));
});

const mirrorEntries = [
  "新增: 同步 CRAN 上游文件 example_0.2.0.tar.gz（版本 0.2.0），SHA-256 已校验。",
];

function scopedOf(changelog: string): string {
  return promoteEntries(changelog, {
    version: "0.2.0",
    date: "2026-10-23",
    releaseUrl,
    categories,
    entries: entriesFromLines(mirrorEntries, categories),
  });
}

test("resumed release must match the current manifest entries and version", () => {
  const options = {
    version: "0.2.0",
    releaseUrl,
    policy: { changelog_file: "CHANGELOG.md", changelog_categories: categories },
    entries: mirrorEntries,
  };
  const merged = scopedOf(base);
  assert.equal(
    assertMergedReleaseSection(merged, options),
    "### 新增\n\n- 同步 CRAN 上游文件 example_0.2.0.tar.gz（版本 0.2.0），SHA-256 已校验。"
  );
  assert.throws(
    () => assertMergedReleaseSection(merged.replace("SHA-256 已校验", "SHA-256 尚未校验"), options),
    /differs from this request's manifest entries/
  );
  assert.throws(
    () => assertMergedReleaseSection(merged.replace("## [0.2.0]", "## [0.3.0]"), options),
    /does not uniquely match/
  );
  assert.throws(
    () =>
      assertMergedReleaseSection(
        merged + "\n## [0.2.0](" + releaseUrl + ") - 2026-10-24\n",
        options
      ),
    /does not uniquely match/
  );
  assert.throws(
    () => assertMergedReleaseSection(merged, { ...options, entries: ["新增: 另一份有效请求。"] }),
    /differs from this request's manifest entries/
  );
});

test("a legacy unscoped release still requires a unique nonempty version section", () => {
  const content = releaseOf(base);
  const options = {
    version: "0.2.0",
    releaseUrl,
    policy: { changelog_file: "CHANGELOG.md", changelog_categories: categories },
  };
  assert.equal(assertMergedReleaseSection(content, options), "### 修复\n\n- 修正超时。");
  assert.throws(
    () =>
      assertMergedReleaseSection(content, { ...options, releaseUrl: "https://example.org/other" }),
    /does not uniquely match/
  );
});

test("scoped releases preserve unrelated Unreleased entries", () => {
  const head = scopedOf(base);
  assert.ok(head.includes("## [Unreleased]\n\n- 修复: 修正超时。\n\n## [0.2.0]"));
  assert.equal(
    releaseSectionBody(head, releaseUrl),
    "### 新增\n\n- 同步 CRAN 上游文件 example_0.2.0.tar.gz（版本 0.2.0），SHA-256 已校验。"
  );
  assert.deepEqual(
    assertScopedReleaseChange({ baseChangelog: base, headChangelog: head, categories }),
    { version: "0.2.0", releaseUrl, date: "2026-10-23" }
  );
});

test("scoped releases reject extra changes and unknown categories", () => {
  const head = scopedOf(base);
  assert.throws(
    () =>
      assertScopedReleaseChange({
        baseChangelog: base,
        headChangelog: head.replace("- 修复: 修正超时。", "- 修复: 修正超时。\n- 修复: 另一项。"),
        categories,
      }),
    /does not match/
  );
  assert.throws(
    () =>
      assertScopedReleaseChange({
        baseChangelog: base,
        headChangelog: head.replace("### 新增", "### 安全"),
        categories,
      }),
    /unknown category/
  );
});

test("manifest entries must use the three Chinese categories", () => {
  assert.throws(() => entriesFromLines(["新增: add a mirror."], categories), /Chinese text/);
  assert.throws(() => entriesFromLines(["安全: 收紧权限。"], categories), /unknown category/);
  assert.throws(() => entriesFromLines([], categories), /No CHANGELOG entries/);
});
