import assert from "node:assert/strict";
import { test } from "node:test";
import { planPack } from "../run-pack.mjs";

test("planPack splits gate suites from unit suites and rejects unknown gate entries", () => {
  const files = ["a-test.mjs", "b-test.mjs", "c-test.mjs"];
  assert.deepEqual(planPack("p", { tiers: { gate: ["b-test.mjs"] } }, files), {
    unit: ["a-test.mjs", "c-test.mjs"],
    gate: ["b-test.mjs"],
  });
  assert.throws(
    () => planPack("p", { tiers: { gate: ["missing-test.mjs"] } }, files),
    /missing suite/
  );
});
