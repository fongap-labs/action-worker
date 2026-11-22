import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyPrMergeability } from "../scripts/pr-merge-preflight.ts";

const repository = "fongap-labs/action-worker";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const prNumber = 21;

function pull(overrides: Record<string, unknown> = {}): unknown {
  return {
    state: "open",
    number: prNumber,
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { sha: headSha, repo: { full_name: repository } },
    base: { sha: baseSha, ref: "main", repo: { full_name: repository } },
    ...overrides,
  };
}

function classify(candidate: unknown): string {
  return classifyPrMergeability(candidate, repository, prNumber, headSha, baseSha);
}

test("clean or gate-blocked PR proceeds to real CI, not directly to merge", () => {
  assert.equal(classify(pull()), "ready");
  assert.equal(classify(pull({ mergeable_state: "blocked" })), "ready");
  assert.equal(classify(pull({ mergeable_state: "unstable" })), "ready");
});

test("pre-existing merge conflicts fail before expensive CI", () => {
  assert.throws(() => classify(pull({ mergeable: false, mergeable_state: "dirty" })), /merge conflicts/);
  assert.throws(() => classify(pull({ mergeable_state: "dirty" })), /merge conflicts/);
  assert.throws(() => classify(pull({ mergeable: false, mergeable_state: "unknown" })), /merge conflicts/);
});

test("unknown GitHub mergeability is never treated as clean", () => {
  assert.equal(classify(pull({ mergeable: null, mergeable_state: "unknown" })), "retry");
  assert.equal(classify(pull({ mergeable_state: "unknown" })), "retry");
  assert.equal(classify(pull({ mergeable: null, mergeable_state: "clean" })), "retry");
});

test("only same-repository behind branches are eligible for automatic refresh", () => {
  assert.equal(classify(pull({ mergeable_state: "behind" })), "refresh");
  assert.throws(() => classify(pull({
    mergeable_state: "behind",
    head: { sha: headSha, repo: { full_name: "untrusted/fork" } },
  })), /cannot be refreshed/);
  assert.equal(classify(pull({ draft: true, mergeable_state: "behind" })), "ready");
});

test("stale and malformed PR facts fail closed", () => {
  for (const candidate of [
    pull({ head: { sha: "c".repeat(40) } }),
    pull({ base: { sha: "c".repeat(40), ref: "main" } }),
    pull({ base: { sha: baseSha, ref: "other" } }),
    pull({ state: "closed" }),
    pull({ number: 22 }),
  ]) assert.throws(() => classify(candidate));
});

test("PR Governance checks conflicts before dispatching full CI", () => {
  const workflow = readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const preflight = workflow.indexOf("- name: Check PR mergeability before expensive CI");
  const dispatch = workflow.indexOf("- name: Dispatch centralized CI");
  assert.ok(preflight > 0 && dispatch > preflight);
  assert.match(workflow, /run: node scripts\/pr-merge-preflight\.ts/);
  assert.match(workflow, /update-branch/);
  assert.match(workflow, /expected_head_sha=\$HEAD_SHA/);
});
