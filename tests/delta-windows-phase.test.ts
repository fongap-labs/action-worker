import assert from "node:assert/strict";
import { test } from "node:test";
import { runBoundedCommand } from "../scripts/delta-windows-phase.ts";

test("bounded Windows phase preserves child success and failure codes", async () => {
  assert.equal(
    await runBoundedCommand("test", process.execPath, ["-e", "process.exit(0)"], 10_000),
    0
  );
  assert.equal(
    await runBoundedCommand("test", process.execPath, ["-e", "process.exit(7)"], 10_000),
    7
  );
});

test("bounded Windows phase terminates a stalled child and fails closed", async () => {
  const code = await runBoundedCommand(
    "test",
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    250
  );
  assert.equal(code, 124);
});
