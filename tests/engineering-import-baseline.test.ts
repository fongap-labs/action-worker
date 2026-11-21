import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveEngineeringDiffBase,
  validateEngineeringDiff,
} from "../scripts/validate-engineering-language.ts";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

test("initial Delta import excludes only unchanged pinned upstream lines", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aw-import-gate-"));
  const originalLog = console.log;
  try {
    git(directory, "init", "-b", "main");
    git(directory, "config", "user.name", "Governance fixture");
    git(
      directory,
      "config",
      "user.email",
      ["governance", "example.invalid"].join(String.fromCharCode(64))
    );

    // This old upstream comment is intentionally not a Delta-authored change.
    const inherited = "// \u4e0a\u6e38 inherited note\nexport const imported = true;\n";
    writeFileSync(join(directory, "inherited.ts"), inherited);
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "upstream");
    const upstreamSha = git(directory, "rev-parse", "HEAD");

    rmSync(join(directory, "inherited.ts"));
    writeFileSync(join(directory, "README.md"), "# Bootstrap\n");
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "bootstrap");
    const bootstrapSha = git(directory, "rev-parse", "HEAD");
    const trusted = { bootstrapSha, upstreamSha };

    writeFileSync(join(directory, "inherited.ts"), inherited);
    writeFileSync(join(directory, "delta.ts"), "export const custom = true;\n");
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "import");
    const importedHead = git(directory, "rev-parse", "HEAD");

    assert.equal(await resolveEngineeringDiffBase(bootstrapSha, directory, trusted), upstreamSha);
    assert.equal(await resolveEngineeringDiffBase(importedHead, directory, trusted), importedHead);
    const inheritedResult = await validateEngineeringDiff(
      bootstrapSha,
      importedHead,
      directory,
      trusted
    );
    assert.equal(inheritedResult.failures, 0);

    writeFileSync(
      join(directory, "delta.ts"),
      "// \u65b0\u589e Delta comment\nexport const custom = true;\n"
    );
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "customization");
    const customizedHead = git(directory, "rev-parse", "HEAD");
    // Avoid emitting a synthetic GitHub annotation from this fixture.
    console.log = () => {};
    const customized = await validateEngineeringDiff(
      bootstrapSha,
      customizedHead,
      directory,
      trusted
    );
    assert.equal(customized.failures, 1);
    assert.equal(customized.files >= 1, true);

    await assert.rejects(
      () =>
        resolveEngineeringDiffBase(bootstrapSha, directory, {
          bootstrapSha,
          upstreamSha: "0".repeat(40),
        }),
      /fatal|bad object|not a valid object/i
    );
  } finally {
    console.log = originalLog;
    rmSync(directory, { recursive: true, force: true });
  }
});
