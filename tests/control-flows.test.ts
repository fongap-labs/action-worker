import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildComparison } from "../scripts/build-review-comparison.ts";
import { detectContext } from "../scripts/detect-pr-context.ts";
import { validateChange } from "../scripts/validate-change-record.ts";
import { runText } from "../scripts/runtime-command.ts";

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
  await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n- feat: Add example capability.\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "feature"]);
  const featureHead = await git(root, ["rev-parse", "HEAD"]);
  const feature = await validateChange("feat(core): add example capability", base, featureHead, root, policyDir);
  assert.equal(feature.scope, "core");
  assert.equal(feature.changelog_changed, true);
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
  await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n- Breaking API migration affecting deployment compatibility.\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "head"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const result = await detectContext(base, head, root, policyDir);
  assert.ok(result.project_types.includes("node"));
  assert.ok(result.project_types.includes("github-automation"));
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
  await writeFile(join(root, ".action-worker-ci-evidence.json"), '{"conclusion":"success"}\n', "utf8");
  const comparison = await buildComparison(root, base, head, ".action-worker-ci-evidence.json");
  assert.equal(await git(root, ["show", `${comparison.base_sha}:.action-worker-ci-evidence.json`]), '{"conclusion":"success"}');
  assert.equal(await git(root, ["show", `${comparison.head_sha}:.action-worker-ci-evidence.json`]), '{"conclusion":"success"}');
  assert.equal(await git(root, ["diff", "--name-only", comparison.base_sha, comparison.head_sha]), "source.txt");
});
