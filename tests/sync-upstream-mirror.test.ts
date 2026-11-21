import assert from "node:assert/strict";
import test from "node:test";
import { isSafeMirrorWorkflow, mirrorUpdateMode, parseMirrorSource } from "../scripts/sync-upstream-mirror.ts";

test("upstream main-only push does not run on the isolated mirror branch", () => {
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    branches: [master]\n", "upstream/deepseek-harness"), true);
});

test("release pattern targeting another branch is safe", () => {
  const source = "on:\n  push:\n    branches: [master, 'release/dsh-[0-9]+.[0-9]+']\n";
  assert.equal(isSafeMirrorWorkflow(source, "upstream/deepseek-harness"), true);
});

test("mirror branch or broad push triggers block the entire sync", () => {
  assert.equal(isSafeMirrorWorkflow("on: push\n", "upstream/deepseek-harness"), false);
  assert.equal(isSafeMirrorWorkflow("on: [push, pull_request]\n", "upstream/deepseek-harness"), false);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    branches: ['upstream/*']\n", "upstream/deepseek-harness"), false);
  assert.equal(
    isSafeMirrorWorkflow("on:\n  push:\n    branches: [upstream/deepseek-harness]\n", "upstream/deepseek-harness"),
    false
  );
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    branches-ignore: [main]\n", "upstream/deepseek-harness"), false);
});

test("manual and tag-only workflows do not execute on branch pushes", () => {
  assert.equal(isSafeMirrorWorkflow("on: workflow_dispatch\n", "upstream/deepseek-harness"), true);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    tags: ['v*']\n", "upstream/deepseek-harness"), true);
});

test("invalid workflow declarations fail closed", () => {
  assert.equal(isSafeMirrorWorkflow("on: [\n", "upstream/deepseek-harness"), false);
  assert.equal(isSafeMirrorWorkflow("name: Missing events\n", "upstream/deepseek-harness"), false);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n", "upstream/deepseek-harness"), false);
});

test("mirror policy pins approved source, target and exact bootstrap SHA", () => {
  const entry = {
    source_repository: "deepseek-ai/deepseek-harness",
    source_branch: "master",
    target_repository: "fongap-labs/ds-harness",
    target_branch: "upstream/deepseek-harness",
    bootstrap_sha: "a00915e10209587d627f1f7f700ae2b395cdc870",
  };
  assert.deepEqual(parseMirrorSource({ schema_version: 1, mirrors: [entry] }), entry);
  assert.throws(() =>
    parseMirrorSource({ schema_version: 1, mirrors: [{ ...entry, target_branch: "main" }] })
  );
  assert.throws(() =>
    parseMirrorSource({ schema_version: 1, mirrors: [{ ...entry, target_repository: "external/target" }] })
  );
  assert.throws(() =>
    parseMirrorSource({ schema_version: 1, mirrors: [{ ...entry, bootstrap_sha: "missing" }] })
  );
  assert.throws(() => parseMirrorSource({ schema_version: 1, mirrors: [entry, entry] }));
});

test("the exact seed allows one leased bootstrap, while later changes must be fast-forwards", () => {
  const seed = "a00915e10209587d627f1f7f700ae2b395cdc870";
  const upstream = "2e39e70496aa02986ca6a820c5d497e816b69d7e";
  assert.equal(mirrorUpdateMode(seed, seed, upstream), "bootstrap");
  assert.equal(mirrorUpdateMode(upstream, seed, upstream), "unchanged");
  assert.equal(mirrorUpdateMode("b".repeat(40), seed, upstream), "fast-forward");
  assert.throws(() => mirrorUpdateMode("main", seed, upstream));
});
