import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  changeAreaForPath,
  detectContext,
  listChangedFiles,
  projectTypeForPath,
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
      "workflow"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project type detection follows changed monorepo paths before root manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "action-worker-project-context-"));
  try {
    await exec("git", ["init", "-q"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });

    const policyDir = join(root, "policies");
    await mkdir(policyDir, { recursive: true });
    await writeFile(
      join(policyDir, "workflow.json"),
      JSON.stringify({ path_prefixes: [".github/workflows/"] }),
      "utf8"
    );
    await writeFile(
      join(policyDir, "security.json"),
      JSON.stringify({ path_terms: ["secret"] }),
      "utf8"
    );
    await writeFile(
      join(policyDir, "release.json"),
      JSON.stringify({
        changelog_file: "CHANGELOG.md",
        changelog_fragment_dir: "changelog.d",
        impact_patterns: {},
      }),
      "utf8"
    );

    await mkdir(join(root, "crates", "delta-core", "src"), { recursive: true });
    await writeFile(join(root, "pyproject.toml"), "[project]\nname='root-python'\n", "utf8");
    const rustFile = join(root, "crates", "delta-core", "src", "runtime.rs");
    await writeFile(rustFile, "pub fn value() -> u8 { 1 }\n", "utf8");
    await writeFile(join(root, "README.md"), "# Test\n", "utf8");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "base"], { cwd: root });
    const { stdout: base } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    await writeFile(rustFile, "pub fn value() -> u8 { 2 }\n", "utf8");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "rust change"], { cwd: root });
    const { stdout: rustHead } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    const rustContext = await detectContext(base.trim(), rustHead.trim(), root, policyDir);
    assert.deepEqual(rustContext.project_types, ["rust"]);

    await writeFile(join(root, "README.md"), "# Test\n\nDocs only.\n", "utf8");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "docs change"], { cwd: root });
    const { stdout: docsHead } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    const docsContext = await detectContext(rustHead.trim(), docsHead.trim(), root, policyDir);
    assert.deepEqual(docsContext.project_types, ["python"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project path classifier recognizes nested language sources", () => {
  assert.equal(projectTypeForPath("crates/delta-core/src/runtime.rs"), "rust");
  assert.equal(projectTypeForPath("packages/sdk/context.py"), "python");
  assert.equal(projectTypeForPath("apps/desktop/src/App.tsx"), "node");
  assert.equal(projectTypeForPath(".github/workflows/validate.yml"), "github-automation");
  assert.equal(projectTypeForPath("docs/ARCHITECTURE.md"), null);
});

test("a release change that deletes changelog fragments does not fail context detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "action-worker-fragment-context-"));
  try {
    await exec("git", ["init", "-q"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });

    const policyDir = join(root, "policies");
    await mkdir(policyDir, { recursive: true });
    await writeFile(
      join(policyDir, "workflow.json"),
      JSON.stringify({ path_prefixes: [".github/workflows/"] }),
      "utf8"
    );
    await writeFile(
      join(policyDir, "security.json"),
      JSON.stringify({ path_terms: ["secret"] }),
      "utf8"
    );
    await writeFile(
      join(policyDir, "release.json"),
      JSON.stringify({
        changelog_file: "CHANGELOG.md",
        changelog_fragment_dir: "changelog.d",
        impact_patterns: { performance: ["latency"] },
      }),
      "utf8"
    );

    await mkdir(join(root, "changelog.d"), { recursive: true });
    const fragment = join(root, "changelog.d", "reduce-latency.md");
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n", "utf8");
    await writeFile(fragment, "- 变更: 降低 latency。\n", "utf8");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "base"], { cwd: root });
    const { stdout: base } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    // The release assembles the fragment into the changelog and removes the fragment file.
    await writeFile(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.1] - 2026-10-23\n\n### 变更\n\n- 降低 latency。\n",
      "utf8"
    );
    await rm(fragment);
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "release"], { cwd: root });
    const { stdout: releaseHead } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    const release = await detectContext(base.trim(), releaseHead.trim(), root, policyDir);
    assert.deepEqual(release.changed_files.sort(), [
      "CHANGELOG.md",
      "changelog.d/reduce-latency.md",
    ]);
    assert.equal(release.changelog_changed, true);

    // A fragment the change adds is still read for its impact declarations.
    await writeFile(
      join(root, "changelog.d", "new-latency.md"),
      "- 变更: 降低 latency。\n",
      "utf8"
    );
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "add fragment"], { cwd: root });
    const { stdout: addHead } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    const added = await detectContext(releaseHead.trim(), addHead.trim(), root, policyDir);
    assert.deepEqual(added.declared_impacts, ["performance"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
