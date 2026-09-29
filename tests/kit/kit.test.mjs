import assert from "node:assert/strict";
import { test } from "node:test";
import { flatten, parseTap, verify } from "./inventory.mjs";

/** @param {Record<string, import("./inventory.mjs").Suite>} suites */
const inventory = (suites) => ({ schema_version: 1, runtime: "node", suites });
/**
 * @param {Record<string, number>} cases
 * @param {string} [status]
 */
const suite = (cases, status = "pass") => ({ status, failed: [], cases });

test("parseTap reads legacy console lines and node:test subtests but not the file entry", () => {
  const output = [
    "TAP version 13",
    "# ok - legacy case",
    "# not ok - broken case",
    "ok 1 - subtest case",
    "ok 2 - tests/example-test.mjs",
  ].join("\n");
  assert.deepEqual(parseTap(output, "example-test.mjs"), {
    cases: { "legacy case": 1, "subtest case": 1 },
    failed: ["broken case"],
  });
});

test("verify fails when a baseline case disappears or drops in count", () => {
  const baseline = inventory({ a: suite({ one: 2, two: 1 }) });
  assert.deepEqual(
    verify(baseline, inventory({ merged: suite({ one: 2, two: 1, three: 1 }) })),
    []
  );
  assert.deepEqual(verify(baseline, inventory({ merged: suite({ one: 1, two: 1 }) })), [
    "missing case (1/2): one",
  ]);
  assert.deepEqual(verify(baseline, inventory({ merged: suite({ one: 2 }, "fail") })), [
    "suite failing: merged",
    "missing case (0/1): two",
  ]);
});

test("flatten sums a case across suites so files can be merged safely", () => {
  assert.deepEqual(flatten(inventory({ a: suite({ x: 1 }), b: suite({ x: 2, y: 1 }) })), {
    x: 3,
    y: 1,
  });
});

test("verify compares python passing state by case name so cases can move between files", () => {
  /** @param {Record<string, import("./inventory.mjs").Suite>} suites */
  const python = (suites) => ({ schema_version: 1, runtime: "python", suites });
  /**
   * @param {Record<string, number>} cases
   * @param {string[]} passed
   */
  const file = (cases, passed) => ({ status: "collected", failed: [], cases, passed });
  const baseline = python({ "a.py": file({ t1: 1, t2: 1 }, ["t1", "t2"]) });
  assert.deepEqual(
    verify(baseline, python({ "merged.py": file({ t1: 1, t2: 1 }, ["t1", "t2"]) })),
    []
  );
  assert.deepEqual(verify(baseline, python({ "merged.py": file({ t1: 1, t2: 1 }, ["t1"]) })), [
    "no longer passing (0/1): t2",
  ]);
});
