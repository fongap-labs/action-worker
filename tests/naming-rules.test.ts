import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { commandFailureMessage } from "../scripts/validate-naming-rules.ts";

test("source naming command failures preserve their diagnostic message", () => {
  assert.equal(
    commandFailureMessage(
      new Error("source naming violations:\n  crates/example.rs: invalid name")
    ),
    "source naming violations:\n  crates/example.rs: invalid name"
  );
  assert.equal(commandFailureMessage("plain failure"), "plain failure");
});

test("unchanged legacy paths may be edited, but newly introduced paths must follow naming rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-naming-regression-"));
  const validator = resolve("scripts/validate-naming-rules.ts");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "CI Test");
    git("config", "user.email", "ci-test");
    await mkdir(join(root, "scripts"));
    const legacy = join(root, "scripts/legacy-release-ingress-handler.ts");
    await writeFile(legacy, "export const count = 1;\n");
    git("add", ".");
    git("commit", "-qm", "add old filename");
    const base = git("rev-parse", "HEAD");

    await writeFile(legacy, "export const count = 2;\n");
    git("add", ".");
    git("commit", "-qm", "edit old filename");
    const head = git("rev-parse", "HEAD");
    const allowed = spawnSync(process.execPath, [validator, base, head], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);

    await writeFile(join(root, "scripts/brand-new-extra-filename.ts"), "export const count = 3;\n");
    git("add", ".");
    git("commit", "-qm", "introduce invalid filename");
    const next = git("rev-parse", "HEAD");
    const rejected = spawnSync(process.execPath, [validator, head, next], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stdout + rejected.stderr,
      /filename must be kebab-case|TypeScript filename/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source naming checks new violations but preserves unchanged inherited identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-source-naming-"));
  const validator = resolve("scripts/validate-source-naming.py");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "CI Test");
    git("config", "user.email", "ci-test");
    await mkdir(join(root, "apps/desktop/src"), { recursive: true });
    const legacy = join(root, "apps/desktop/src/legacy-engine.ts");
    const original =
      "export function launch(ready: boolean) { const moved = true; return ready && moved; }\\n";
    await writeFile(legacy, original);
    git("add", ".");
    git("commit", "-qm", "baseline includes inherited identifiers");
    const base = git("rev-parse", "HEAD");

    await writeFile(legacy, original + "export const isReady = true;\\n");
    git("add", ".");
    git("commit", "-qm", "edit legacy file without adding bad names");
    const head = git("rev-parse", "HEAD");
    const allowed = spawnSync("python3", [validator, base, head], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);

    await writeFile(legacy, original + "export const isReady = true;\\nconst blocked = false;\\n");
    git("add", ".");
    git("commit", "-qm", "introduce new invalid boolean name");
    const next = git("rev-parse", "HEAD");
    const rejected = spawnSync("python3", [validator, head, next], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /boolean TypeScript variable 'blocked'/);
    assert.doesNotMatch(rejected.stderr, /'ready'|'moved'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Delta imported naming checks use the same pinned upstream baseline at all layers", async () => {
  const source = await readFile(resolve("scripts/validate-naming-rules.ts"), "utf8");
  assert.match(
    source,
    /const comparisonBase = await resolveEngineeringDiffBase\(base, process\.cwd\(\)\)/
  );
  assert.match(source, /"--diff-filter=ACMR",\s*comparisonBase,\s*head/);
  assert.match(source, /"--diff-filter=ACR",\s*comparisonBase,\s*head/);
  assert.match(source, /"validate-source-naming\.py"\),\s*comparisonBase,\s*head/);
  assert.match(source, /validateConfigNames\(comparisonBase, head\)/);
});
