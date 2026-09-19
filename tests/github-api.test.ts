import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GithubReader,
  isGithubMissing,
  isRetryableStatus,
  parseRetryAfter,
} from "../scripts/github-api.ts";
import { CliError } from "../scripts/runtime-command.ts";

test("GitHub retries only transient HTTP failures", () => {
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(422), false);
});

test("Retry-After supports seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("3", 0), 3000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1000), 4000);
  assert.equal(parseRetryAfter("invalid", 0), undefined);
});

test("existence checks distinguish missing resources from API failures", () => {
  assert.equal(isGithubMissing(new CliError("gh: Not Found (HTTP 404)")), true);
  assert.equal(isGithubMissing(new CliError("GitHub API returned HTTP 500.")), false);
  assert.equal(isGithubMissing(new Error("HTTP 404")), false);
});

test("GitHub readers fail fast for permanent HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("not found", { status: 404 });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "", {
      attemptLimit: 4,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    await assert.rejects(() => reader.get("repos/example/missing"), /HTTP 404/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub readers retry transient HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("unavailable", { status: 503 })
      : Response.json({ ok: true });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "", {
      attemptLimit: 2,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    assert.deepEqual(await reader.get("rate-limited"), { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
