import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
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
      "workflow",
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
      "utf8",
    );
    await writeFile(
      join(policyDir, "security.json"),
      JSON.stringify({ path_terms: ["secret"] }),
      "utf8",
    );
    await writeFile(
      join(policyDir, "release.json"),
      JSON.stringify({ changelog_file: "CHANGELOG.md", impact_patterns: {} }),
      "utf8",
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

    const rustContext = await detectContext(
      base.trim(),
      rustHead.trim(),
      root,
      policyDir,
    );
    assert.deepEqual(rustContext.project_types, ["rust"]);

    await writeFile(join(root, "README.md"), "# Test\n\nDocs only.\n", "utf8");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "docs change"], { cwd: root });
    const { stdout: docsHead } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    const docsContext = await detectContext(
      rustHead.trim(),
      docsHead.trim(),
      root,
      policyDir,
    );
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
