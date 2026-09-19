import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError, runCommand } from "../scripts/runtime-command.ts";

test("commands cap combined standard output and error output", async () => {
  await assert.rejects(
    () => runCommand(process.execPath, [
      "-e",
      "process.stdout.write('a'.repeat(32)); process.stderr.write('b'.repeat(32));",
    ], { maxBuffer: 48 }),
    (error: unknown) => error instanceof CliError && /exceeded 48 bytes/.test(error.message),
  );
});

test("commands stop after their configured timeout", async () => {
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000);"], { timeoutMs: 50 }),
    (error: unknown) => error instanceof CliError && error.exitCode === 124,
  );
});
