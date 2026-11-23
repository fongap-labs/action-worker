import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensurePinnedImportSourceAvailable,
  resolveSourceImportBase,
  SOURCE_IMPORT_BASELINES,
} from "../scripts/source-import-baselines.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("source import baselines are exact immutable SHA mappings", () => {
  assert.deepEqual(
    SOURCE_IMPORT_BASELINES.map(({ bootstrapSha, upstreamSha, sourceRepository }) => [
      bootstrapSha,
      sourceRepository,
      upstreamSha,
    ]),
    [
      [
        "7556dc8dfede03053e35359f2b55dd299da1f3ee",
        "https://github.com/deepseek-ai/deepseek-harness.git",
        "2e39e70496aa02986ca6a820c5d497e816b69d7e",
      ],
      [
        "3effeb139e9af5198bfa5d380b1d3457caea4fcb",
        "https://github.com/deepseek-ai/deepseek-harness.git",
        "4b399c39a6d1479cd84ca591b4d7c88e24d38a96",
      ],
    ]
  );
  assert.equal(
    resolveSourceImportBase("3effeb139e9af5198bfa5d380b1d3457caea4fcb"),
    "4b399c39a6d1479cd84ca591b4d7c88e24d38a96"
  );
  assert.equal(resolveSourceImportBase("0".repeat(40)), "0".repeat(40));
});

test("a missing pinned source commit is fetched from its fixed source without checkout", () => {
  const scratch = mkdtempSync(join(tmpdir(), "aw-delta-source-baseline-"));
  const sourceWork = join(scratch, "source-work");
  const sourceBare = join(scratch, "source.git");
  const target = join(scratch, "target");
  try {
    mkdirSync(sourceWork, { recursive: true });
    mkdirSync(target, { recursive: true });
    git(sourceWork, "init", "-b", "main");
    git(sourceWork, "config", "user.name", "Governance fixture");
    git(sourceWork, "config", "user.email", "fixture.invalid");
    writeFileSync(join(sourceWork, "inherited.ts"), "export const imported = true;\n");
    git(sourceWork, "add", "-A");
    git(sourceWork, "commit", "-m", "pinned source");
    const upstreamSha = git(sourceWork, "rev-parse", "HEAD");
    execFileSync("git", ["init", "--bare", sourceBare], { stdio: "ignore" });
    git(sourceWork, "remote", "add", "fixture", sourceBare);
    git(sourceWork, "push", "fixture", "main");

    git(target, "init", "-b", "main");
    git(target, "config", "user.name", "Governance fixture");
    git(target, "config", "user.email", "fixture.invalid");
    writeFileSync(join(target, "README.md"), "Delta bootstrap\n");
    git(target, "add", "-A");
    git(target, "commit", "-m", "bootstrap");
    writeFileSync(join(target, "inherited.ts"), "export const imported = true;\n");
    writeFileSync(join(target, "delta.ts"), "export const custom = true;\n");
    git(target, "add", "-A");
    git(target, "commit", "-m", "import");
    const head = git(target, "rev-parse", "HEAD");

    assert.equal(
      ensurePinnedImportSourceAvailable(target, {
        bootstrapSha: "a".repeat(40),
        upstreamSha,
        sourceRepository: sourceBare,
      }),
      upstreamSha
    );
    assert.equal(git(target, "rev-parse", "--verify", `${upstreamSha}^{commit}`), upstreamSha);
    assert.deepEqual(git(target, "diff", "--name-only", upstreamSha, head).split(/\r?\n/).sort(), [
      "README.md",
      "delta.ts",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
