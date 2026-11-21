import assert from "node:assert/strict";
import test from "node:test";
import { isSafeMirrorWorkflow } from "../scripts/sync-delta-upstream.ts";

test("upstream main-only push does not run on the Delta mirror branch", () => {
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    branches: [master]\n"), true);
});

test("release pattern targeting another branch is safe", () => {
  const source = "on:\n  push:\n    branches: [master, 'release/dsh-[0-9]+.[0-9]+']\n";
  assert.equal(isSafeMirrorWorkflow(source), true);
});

test("mirror branch or broad push triggers block the entire sync", () => {
  assert.equal(isSafeMirrorWorkflow("on: push\n"), false);
  assert.equal(isSafeMirrorWorkflow("on: [push, pull_request]\n"), false);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    branches: ['upstream/*']\n"), false);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    branches: [upstream/deepseek-harness]\n"), false);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    branches-ignore: [main]\n"), false);
});

test("manual and tag-only workflows do not execute on branch pushes", () => {
  assert.equal(isSafeMirrorWorkflow("on: workflow_dispatch\n"), true);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n    tags: ['v*']\n"), true);
});

test("invalid workflow declarations fail closed", () => {
  assert.equal(isSafeMirrorWorkflow("on: [\n"), false);
  assert.equal(isSafeMirrorWorkflow("name: Missing events\n"), false);
  assert.equal(isSafeMirrorWorkflow("on:\n  push:\n"), false);
});
