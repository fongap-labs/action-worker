import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const source = await readFile("templates/bridge/notify-action-worker.yml", "utf8");
const workflow = parse(source) as Workflow;
const dispatched = Object.values(workflow.jobs)
  .flatMap((job) => job.steps)
  .filter((step) =>
    [
      "Dispatch central governance",
      "Cancel central work for the closed pull request",
      "Wake Action Worker Intake",
    ].includes(step.name ?? "")
  );

function helperFrom(step: Step): string {
  const functionText = step.run?.match(/(?:^|\n)dispatch_with_diagnostics\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionText, `missing diagnostic helper in ${step.name ?? "unknown"}`);
  return functionText;
}

function execute(
  helper: string,
  scenario: { status: number; message?: string; headers?: string }
): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "aw-dispatch-"));
  const curl = join(root, "curl");
  writeFileSync(
    curl,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "out=''",
      "headers=''",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --output) out="$2"; shift 2 ;;',
      '    --dump-header) headers="$2"; shift 2 ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      'printf \'%s\' "$MOCK_BODY" > "$out"',
      'printf \'%s\' "$MOCK_HEADERS" > "$headers"',
      "printf '%s' \"$MOCK_STATUS\"",
      "",
    ].join("\n")
  );
  chmodSync(curl, 0o755);
  try {
    const result = spawnSync(
      "bash",
      ["-c", `set -Eeuo pipefail\n${helper}\ndispatch_with_diagnostics '{}' `],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          AW_DISPATCH_TOKEN: "SENTINEL-SECRET-NEVER-PRINT",
          GITHUB_REPOSITORY_OWNER: "fongap-labs",
          MOCK_STATUS: String(scenario.status),
          MOCK_HEADERS: scenario.headers ?? "",
          MOCK_BODY: JSON.stringify({
            message: scenario.message ?? "example",
            private: "SENTINEL-SECRET-NEVER-PRINT",
          }),
        },
        encoding: "utf8",
      }
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("all three thin bridge entries share bounded dispatch diagnostics", () => {
  assert.equal(dispatched.length, 3);
  for (const step of dispatched) {
    const helper = helperFrom(step);
    assert.match(helper, /--dump-header "\$response_headers"/);
    assert.match(helper, /--output "\$response_body"/);
    assert.match(
      helper,
      /x-ratelimit-remaining\|x-ratelimit-limit\|x-ratelimit-reset\|retry-after/
    );
    assert.match(helper, /if \[ "\$http_code" = "204" \]/);
    assert.doesNotMatch(helper, /cat "\$response_body"|echo "\$message"/);
    assert.match(step.run ?? "", /dispatch_with_diagnostics/);
  }
});

test("the bridge preserves successful dispatches and fails closed on rate limits", () => {
  for (const step of dispatched) {
    const helper = helperFrom(step);
    const success = execute(helper, { status: 204 });
    assert.equal(success.status, 0, step.name ?? "dispatch entry");
    const limited = execute(helper, {
      status: 403,
      message:
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      headers:
        "HTTP/2 403\r\nx-ratelimit-remaining: 0\r\nretry-after: 60\r\nX-Unsafe: secret-metadata\r\n",
    });
    assert.equal(limited.status, 1, step.name ?? "dispatch entry");
    assert.match(limited.stderr, /HTTP 403, reason=secondary-rate-limit/);
    assert.match(limited.stderr, /x-ratelimit-remaining=0/);
    assert.match(limited.stderr, /retry-after=60/);
    assert.doesNotMatch(
      limited.stderr + limited.stdout,
      /secret-metadata|SENTINEL-SECRET-NEVER-PRINT/
    );
  }
});

test("the bridge categorizes authorization errors without logging API response bodies", () => {
  const helper = helperFrom(dispatched[0] ?? {});
  const result = execute(helper, {
    status: 403,
    message: "Resource not accessible by personal access token",
    headers: "HTTP/2 403\r\nx-ratelimit-remaining: 49\r\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reason=token-access-denied/);
  assert.match(result.stderr, /x-ratelimit-remaining=49/);
  assert.doesNotMatch(
    result.stderr + result.stdout,
    /SENTINEL-SECRET-NEVER-PRINT|Resource not accessible by personal access token/
  );
});
