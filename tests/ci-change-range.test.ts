import assert from "node:assert/strict";
import { test } from "node:test";
import { type CiRangeInputs, resolveCiChangeRange } from "../scripts/ci-change-range.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const root = "c".repeat(40);
const input: CiRangeInputs = {
  event: "pull_request",
  prBase: base,
  prHead: head,
  pushBefore: base,
  sha: head,
};

test("CI range resolver preserves pull request and regular push heads", () => {
  const noGit = (): never => {
    throw new Error("Git should not be required for a normal PR or push");
  };
  assert.deepEqual(resolveCiChangeRange(input, noGit), { base, head });
  assert.deepEqual(resolveCiChangeRange({ ...input, event: "push" }, noGit), { base, head });
});

test("CI range resolver recovers the root on a zero-before initial push", () => {
  const calls: string[][] = [];
  const range = resolveCiChangeRange(
    { ...input, event: "push", pushBefore: "0".repeat(40) },
    (args) => {
      calls.push(args);
      return root;
    }
  );
  assert.deepEqual(range, { base: root, head });
  assert.deepEqual(calls, [["rev-list", "--max-parents=0", head]]);
});

test("CI range resolver prefers parent and falls back to root for other events", () => {
  assert.deepEqual(
    resolveCiChangeRange({ ...input, event: "other" }, () => base),
    {
      base,
      head,
    }
  );
  const calls: string[][] = [];
  const result = resolveCiChangeRange({ ...input, event: "other" }, (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") throw new Error("first commit has no parent");
    return root;
  });
  assert.deepEqual(result, { base: root, head });
  assert.deepEqual(calls, [
    ["rev-parse", `${head}^`],
    ["rev-list", "--max-parents=0", head],
  ]);
});
