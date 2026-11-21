import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError, runCommand, runTextLines } from "../scripts/runtime-command.ts";

test("commands cap combined standard output and error output", async () => {
  await assert.rejects(
    () =>
      runCommand(
        process.execPath,
        ["-e", "process.stdout.write('a'.repeat(32)); process.stderr.write('b'.repeat(32));"],
        { maxBuffer: 48 }
      ),
    (error: unknown) => error instanceof CliError && /exceeded 48 bytes/.test(error.message)
  );
});

test("commands stop after their configured timeout", async () => {
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000);"], { timeoutMs: 50 }),
    (error: unknown) => error instanceof CliError && error.exitCode === 124
  );
});

test("streams output above the buffered command limit without truncating lines", async () => {
  const count = 8_192;
  const width = 7_000;
  let observed = 0;
  for await (const line of runTextLines(process.execPath, [
    "-e",
    "const line = 'x'.repeat(7000) + '\\n'; for (let i = 0; i < 8192; i++) process.stdout.write(line);",
  ])) {
    assert.equal(line.length, width);
    observed += 1;
  }
  assert.equal(observed, count);
  assert.ok(count * (width + 1) > 50 * 1024 * 1024);
});

test("streaming commands fail closed on nonzero exit status", async () => {
  await assert.rejects(
    async () => {
      for await (const _line of runTextLines(process.execPath, [
        "-e",
        "process.stdout.write('partial\\n'); process.stderr.write('broken diff'); process.exit(23);",
      ])) {
        // An earlier output line does not make a failed command successful.
      }
    },
    (error: unknown) => error instanceof CliError && error.exitCode === 23 && /broken diff/.test(error.message)
  );
});
