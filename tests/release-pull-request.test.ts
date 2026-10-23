import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertReleaseChange,
  promoteUnreleased,
  releaseSectionBody,
} from "../scripts/changelog-release.ts";
import { releasePullRequestTitle } from "../scripts/changelog-release-pr.ts";
import { runText } from "../scripts/runtime-command.ts";
import { validateChange } from "../scripts/validate-change-record.ts";

const policyDir = resolve("policies");
const categories = ["新增", "变更", "弃用", "移除", "修复", "安全"];
const releaseUrl = "https://github.com/fongap-labs/example/releases/tag/example-v0.2.0";
const base =
  "# Changelog\n\n## [Unreleased]\n\n- 修复: 修正超时。\n\n## [0.1.0](https://github.com/fongap-labs/example/releases/tag/example-v0.1.0) - 2026-10-01\n\n### 修复\n\n- 旧条目。\n";
const fragment = "- 新增: 增加导出命令。\n";

function releaseOf(changelog: string, fragments: string[]): string {
  return promoteUnreleased(changelog, {
    version: "0.2.0",
    date: "2026-10-23",
    releaseUrl,
    categories,
    fragments,
  });
}

test("a release change must be exactly what the unreleased entries and removed fragments produce", () => {
  const head = releaseOf(base, [fragment]);
  const heading = assertReleaseChange({
    baseChangelog: base,
    headChangelog: head,
    removedFragments: [fragment],
    categories,
  });
  assert.deepEqual(heading, { version: "0.2.0", releaseUrl, date: "2026-10-23" });

  assert.throws(
    () =>
      assertReleaseChange({
        baseChangelog: base,
        headChangelog: head.replace("增加导出命令", "增加另一项能力"),
        removedFragments: [fragment],
        categories,
      }),
    /does not match/
  );
  assert.throws(
    () =>
      assertReleaseChange({
        baseChangelog: base,
        headChangelog: head,
        removedFragments: [],
        categories,
      }),
    /does not match/
  );
});

test("a release change adds exactly one version section", () => {
  const head = `${releaseOf(base, [fragment])}\n## [0.0.9](${releaseUrl}) - 2026-09-01\n`;
  assert.throws(
    () =>
      assertReleaseChange({
        baseChangelog: base,
        headChangelog: head,
        removedFragments: [fragment],
        categories,
      }),
    /exactly one version section/
  );
});

test("the body of a version section is its category groups", () => {
  const body = releaseSectionBody(releaseOf(base, [fragment]), "0.2.0");
  assert.equal(body, "### 新增\n\n- 增加导出命令。\n\n### 修复\n\n- 修正超时。");
});

test("the release pull request title is one the change record validator accepts as a release", () => {
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

test("the change record accepts a release pull request and refuses anything beyond it", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await writeFile(join(root, "CHANGELOG.md"), base, "utf8");
  await mkdir(join(root, "changelog.d"), { recursive: true });
  await writeFile(join(root, "changelog.d", "add-export.md"), fragment, "utf8");
  const baseSha = await commit(root, "base");

  const title = releasePullRequestTitle("example-v0.2.0");
  await writeFile(join(root, "CHANGELOG.md"), releaseOf(base, [fragment]), "utf8");
  await runText("git", ["rm", "-q", "changelog.d/add-export.md"], { cwd: root });
  const releaseSha = await commit(root, "release");
  const record = await validateChange(title, baseSha, releaseSha, root, policyDir);
  assert.equal(record.type, "chore");
  assert.equal(record.changelog_required, false);

  await runText("git", ["reset", "--hard", "-q", baseSha], { cwd: root });
  await writeFile(join(root, "CHANGELOG.md"), releaseOf(base, [fragment]), "utf8");
  await runText("git", ["rm", "-q", "changelog.d/add-export.md"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Fixture\n\nChanged.\n", "utf8");
  const extraSha = await commit(root, "release with an extra file");
  await assert.rejects(validateChange(title, baseSha, extraSha, root, policyDir));

  // A fragment that is kept, or edited on the way, is not a removal of what was released.
  await runText("git", ["reset", "--hard", "-q", baseSha], { cwd: root });
  await writeFile(join(root, "CHANGELOG.md"), releaseOf(base, [fragment]), "utf8");
  await writeFile(join(root, "changelog.d", "add-export.md"), "- 新增: 增加另一项能力。\n", "utf8");
  const editedSha = await commit(root, "release with an edited fragment");
  await assert.rejects(validateChange(title, baseSha, editedSha, root, policyDir));
});
