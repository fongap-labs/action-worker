import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildComparison } from "../scripts/build-review-comparison.ts";
import { detectContext } from "../scripts/detect-pr-context.ts";
import { runText } from "../scripts/runtime-command.ts";
import { validateChange } from "../scripts/validate-change-record.ts";

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

test("change record enforces title and CHANGELOG contracts", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "README.md"), "# Fixture\n\nMore docs.\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-qm", "docs"]);
  const docsHead = await git(root, ["rev-parse", "HEAD"]);
  const docs = await validateChange("docs: clarify setup", base, docsHead, root, policyDir);
  assert.equal(docs.type, "docs");
  assert.equal(docs.changelog_required, false);
  await assert.rejects(validateChange("feature: invalid type", base, docsHead, root, policyDir));
  await assert.rejects(validateChange("feat: add feature", base, docsHead, root, policyDir));

  await git(root, ["reset", "--hard", "-q", base]);
  await writeFile(join(root, "README.md"), "# Fixture\n\nFeature.\n", "utf8");
  await mkdir(join(root, "changelog.d"), { recursive: true });
  await writeFile(
    join(root, "changelog.d", "example-capability.md"),
    "- 新增: 增加示例能力。\n",
    "utf8"
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "feature"]);
  const featureHead = await git(root, ["rev-parse", "HEAD"]);
  const feature = await validateChange(
    "feat(core): add example capability",
    base,
    featureHead,
    root,
    policyDir
  );
  assert.equal(feature.scope, "core");
  assert.equal(feature.changelog_changed, true);

  // CHANGELOG_CONVENTIONS §5: Chinese summary, a category the PR type may write, and the
  // security category exactly with the security attribute.
  const rejected = [
    "- 新增: add example capability.",
    "- 修复: 修复示例能力。",
    "- 新增 [security]: 增加示例能力。",
    "- 安全: 收紧示例能力。",
  ];
  for (const entry of rejected) {
    await git(root, ["reset", "--hard", "-q", base]);
    await mkdir(join(root, "changelog.d"), { recursive: true });
    await writeFile(join(root, "changelog.d", "bad-entry.md"), `${entry}\n`, "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "bad entry"]);
    const badHead = await git(root, ["rev-parse", "HEAD"]);
    await assert.rejects(
      validateChange("feat(core): add example capability", base, badHead, root, policyDir),
      `${entry} must be refused`
    );
  }

  // Pull requests do not write the unreleased section of CHANGELOG.md: a fragment carries the entry.
  await git(root, ["reset", "--hard", "-q", base]);
  await writeFile(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n- 新增: 增加示例能力。\n",
    "utf8"
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "direct entry"]);
  const directHead = await git(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    validateChange("feat(core): add example capability", base, directHead, root, policyDir),
    "a direct edit of the unreleased section must be refused"
  );

  // Fragment names are new, lowercase and kebab-case.
  await git(root, ["reset", "--hard", "-q", base]);
  await mkdir(join(root, "changelog.d"), { recursive: true });
  await writeFile(
    join(root, "changelog.d", "Example_Capability.md"),
    "- 新增: 增加示例能力。\n",
    "utf8"
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "bad name"]);
  const badNameHead = await git(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    validateChange("feat(core): add example capability", base, badNameHead, root, policyDir),
    "a fragment name that is not kebab-case must be refused"
  );

  // A fragment already on the base branch is never edited by another change.
  await git(root, ["reset", "--hard", "-q", base]);
  await mkdir(join(root, "changelog.d"), { recursive: true });
  await writeFile(join(root, "changelog.d", "shared-name.md"), "- 新增: 增加示例能力。\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "seed fragment"]);
  const seedHead = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(
    join(root, "changelog.d", "shared-name.md"),
    "- 新增: 增加另一项能力。\n",
    "utf8"
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "edit fragment"]);
  const editHead = await git(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    validateChange("feat(core): add example capability", seedHead, editHead, root, policyDir),
    "an existing fragment must not be edited"
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
