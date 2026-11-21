import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    git("config", "user.email", "ci-test@example.invalid");
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

    await writeFile(
      join(root, "scripts/brand-new-extra-filename.ts"),
      "export const count = 3;\n"
    );
    git("add", ".");
    git("commit", "-qm", "introduce invalid filename");
    const next = git("rev-parse", "HEAD");
    const rejected = spawnSync(process.execPath, [validator, head, next], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /filename must be kebab-case|TypeScript filename/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
