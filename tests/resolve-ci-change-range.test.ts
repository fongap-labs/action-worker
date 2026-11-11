import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function runRange(event: string, base: string, head: string): string {
  const directory = mkdtempSync(join(tmpdir(), "aw-ci-range-"));
  const output = join(directory, "output");
  try {
    const run = spawnSync("bash", ["scripts/resolve-ci-change-range.sh"], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        PR_BASE_SHA: base,
        PR_HEAD_SHA: head,
        PUSH_BEFORE_SHA: base,
        GITHUB_SHA: head,
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("shared CI range resolver preserves pull request and push ranges", () => {
  if (process.platform === "win32") return;
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const expected = `base=${base}\nhead=${head}\n`;
  assert.equal(runRange("pull_request", base, head), expected);
  assert.equal(runRange("push", base, head), expected);
});
