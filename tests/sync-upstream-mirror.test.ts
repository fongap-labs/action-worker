import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeMirrorWorkflow,
  mirrorUpdateMode,
  parseMirrorSource,
} from "../scripts/sync-upstream-mirror.ts";

const branch = "upstream/deepseek-harness";

test("upstream main-only push does not run on the isolated mirror branch", () => {
  const source = "on:\n  push:\n    branches: [master]\n";
  assert.equal(isSafeMirrorWorkflow(source, branch), true);
});

test("release branch patterns are separate from the mirror", () => {
  const source = "on:\n  push:\n    branches: [master, 'release/dsh-[0-9]+.[0-9]+']\n";
  assert.equal(isSafeMirrorWorkflow(source, branch), true);
});

test("broad and matching branch push events prevent mirroring", () => {
  const denied = [
    "on: push\n",
    "on: [push, pull_request]\n",
    "on:\n  push:\n    branches: ['upstream/*']\n",
    "on:\n  push:\n    branches: [upstream/deepseek-harness]\n",
    "on:\n  push:\n    branches-ignore: [main]\n",
  ];
  for (const source of denied) {
    assert.equal(isSafeMirrorWorkflow(source, branch), false);
  }
});

test("manual, tags-only and non-push workflows cannot run on mirror pushes", () => {
  const allowed = [
    "on: workflow_dispatch\n",
    "on:\n  push:\n    tags: ['v*']\n",
  ];
  for (const source of allowed) {
    assert.equal(isSafeMirrorWorkflow(source, branch), true);
  }
});

test("invalid workflow declarations fail closed", () => {
  const denied = ["on: [\n", "name: Missing events\n", "on:\n  push:\n"];
  for (const source of denied) {
    assert.equal(isSafeMirrorWorkflow(source, branch), false);
  }
});

test("mirror policy pins the approved source, target, and initial commit", () => {
  const entry = {
    source_repository: "deepseek-ai/deepseek-harness",
    source_branch: "master",
    target_repository: "fongap-labs/ds-harness",
    target_branch: branch,
    bootstrap_sha: "a00915e10209587d627f1f7f700ae2b395cdc870",
  };
  const wrap = (mirrors: unknown[]) => ({ schema_version: 1, mirrors });
  assert.deepEqual(parseMirrorSource(wrap([entry])), entry);
  assert.throws(() => parseMirrorSource(wrap([{ ...entry, target_branch: "main" }])));
  assert.throws(() => parseMirrorSource(wrap([{ ...entry, target_repository: "other/repo" }])));
  assert.throws(() => parseMirrorSource(wrap([{ ...entry, bootstrap_sha: "missing" }])));
  assert.throws(() => parseMirrorSource(wrap([entry, entry])));
});

test("only the initial SHA may be replaced once; later updates must be fast-forwards", () => {
  const seed = "a00915e10209587d627f1f7f700ae2b395cdc870";
  const upstream = "2e39e70496aa02986ca6a820c5d497e816b69d7e";
  assert.equal(mirrorUpdateMode(seed, seed, upstream), "bootstrap");
  assert.equal(mirrorUpdateMode(upstream, seed, upstream), "unchanged");
  assert.equal(mirrorUpdateMode("b".repeat(40), seed, upstream), "fast-forward");
  assert.throws(() => mirrorUpdateMode("main", seed, upstream));
});
