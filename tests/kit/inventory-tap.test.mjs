import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyTapInventory } from "./verify-tap-inventory.mjs";

const baseline = {
  schema_version: 1,
  runtime: "node",
  suites: {
    source: {
      status: "pass",
      failed: [],
      cases: {
        "first contract": 1,
        "second contract": 1,
      },
    },
  },
};
const output = [
  "TAP version 13",
  "# Subtest: first contract",
  "ok 1 - first contract",
  "# Subtest: second contract",
  "ok 2 - second contract",
  "1..2",
  "# tests 2",
  "# pass 2",
  "# fail 0",
].join("\n");

test("trusted TAP inventory recognizes all original cases in a successful Node run", () => {
  assert.deepEqual(verifyTapInventory(baseline, output), []);
});

test("trusted TAP inventory refuses missing and renamed cases even with green footer", () => {
  const reduced = output.replaceAll("second contract", "renamed contract");
  assert.match(verifyTapInventory(baseline, reduced).join(" "), /missing case/);
});

test("trusted TAP inventory rejects fewer executions or missing TAP footer", () => {
  const reducedCount = output.replace("# tests 2", "# tests 1");
  assert.match(verifyTapInventory(baseline, reducedCount).join(" "), /fewer executed tests/);
  assert.match(verifyTapInventory(baseline, output.replace("# fail 0", "")).join(" "), /footer/);
  assert.match(verifyTapInventory(baseline, "all good").join(" "), /missing Node TAP/);
});

test("trusted TAP inventory rejects failed tests and malformed reference manifests", () => {
  const failed = output
    .replace("ok 2 - second contract", "not ok 2 - second contract")
    .replace("# fail 0", "# fail 1");
  assert.notDeepEqual(verifyTapInventory(baseline, failed), []);
  assert.match(
    verifyTapInventory({ schema_version: 1, runtime: "node" }, output).join(" "),
    /invalid/
  );
});
