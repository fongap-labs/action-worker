import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyGithubFailure,
  GithubHttpError,
  GithubReader,
  isGithubMissing,
  isRetryableStatus,
  parseRetryAfter,
  statusAwareReader,
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
    return calls === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ ok: true });
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

test("GitHub 403 distinguishes primary quota exhaustion from missing permissions", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json(
      { message: "API rate limit exceeded for user ID 12345." },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "4102444800",
          "x-github-request-id": "TRACE-123",
        },
      }
    );
  };
  try {
    const reader = new GithubReader("https://api.github.test", "test-placeholder", {
      attemptLimit: 3,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    await assert.rejects(
      () => reader.get("repos/example/project?token=not-a-real-token"),
      (error: unknown) => {
        assert.ok(error instanceof GithubHttpError);
        assert.equal(error.kind, "primary-rate-limit");
        assert.match(error.message, /HTTP 403/);
        assert.match(error.message, /repos\/example\/project/);
        assert.match(error.message, /reset at/);
        assert.match(error.message, /TRACE-123/);
        assert.ok(!error.message.includes("not-a-real-token"));
        return true;
      }
    );
    assert.equal(calls.length, 1, "an exhausted primary quota must not be retried immediately");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub 403 permission failure is not treated as a transient rate limit", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      { message: "Resource not accessible by personal access token" },
      {
        status: 403,
      }
    );
  };
  try {
    const reader = new GithubReader("https://api.github.test", "test-placeholder", {
      attemptLimit: 4,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    await assert.rejects(
      () => reader.get("repos/example/project"),
      (error: unknown) => {
        assert.ok(error instanceof GithubHttpError);
        assert.equal(error.kind, "permission");
        assert.match(error.message, /permissions and SSO/);
        return true;
      }
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("secondary limits remain retryable when GitHub returns a retry-after header", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return attempts === 1
      ? Response.json(
          { message: "You have exceeded a secondary rate limit." },
          {
            status: 403,
            headers: { "retry-after": "0" },
          }
        )
      : Response.json({ ok: true });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "test-placeholder", {
      attemptLimit: 2,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    assert.deepEqual(await reader.get("repos/example/project"), { ok: true });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(classifyGithubFailure(403, new Headers(), "Forbidden"), "permission");
});

test("status-aware reader uses the dedicated status App token for full owner/repo paths", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; auth: string }> = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: String(url).replace("https://api.github.test/", ""),
      auth: headers.get("authorization") ?? "",
    });
    return Response.json({ statuses: [] });
  };
  try {
    const reader = statusAwareReader("https://api.github.test", "control-read", "status-read");
    for (const path of [
      "repos/fongap-labs/internal-vault/commits/abc123/status",
      "repos/fongap-labs/internal-vault/commits/abc123/status?per_page=100",
      "repos/fongap-labs/internal-vault/statuses/abc123",
    ]) {
      await reader.get(path);
    }
    await reader.get("repos/fongap-labs/internal-vault/commits/main");
    await reader.get("repos/fongap-labs/internal-vault");
    assert.deepEqual(calls.map((call) => call.auth), [
      "Bearer status-read",
      "Bearer status-read",
      "Bearer status-read",
      "Bearer control-read",
      "Bearer control-read",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status-aware reader fails closed when either dedicated token is missing", () => {
  assert.throws(
    () => statusAwareReader("https://api.github.test", "control-read", ""),
    /no token fallback/
  );
  assert.throws(
    () => statusAwareReader("https://api.github.test", "", "status-read"),
    /no token fallback/
  );
});
