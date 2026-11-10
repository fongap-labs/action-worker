import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRetryableStatusWriteError,
  postGithubCommitStatus,
  responseRetryDelayMs,
  retryTransientStatusWrite,
} from "../scripts/status-write-retry.ts";

test("status writes retry transient GitHub failures and stop when recovered", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await retryTransientStatusWrite(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("gh: Server Error (HTTP 502)");
      return "written";
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    3,
    () => 0.5
  );
  assert.equal(result, "written");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test("status writes never retry permission failures or malformed requests", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientStatusWrite(
      async () => {
        calls += 1;
        throw new Error("Resource not accessible by integration (HTTP 403)");
      },
      async () => {}
    ),
    /HTTP 403/
  );
  assert.equal(calls, 1);
  assert.equal(isRetryableStatusWriteError(new Error("HTTP 403")), false);
  assert.equal(isRetryableStatusWriteError(new Error("HTTP 404")), false);
  assert.equal(isRetryableStatusWriteError(new Error("HTTP 502")), true);
  assert.equal(isRetryableStatusWriteError(new Error("ECONNRESET")), true);
});

test("status writes stop after the bounded retry budget", async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    retryTransientStatusWrite(
      async () => {
        calls += 1;
        throw new Error("HTTP 503");
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
      3,
      () => 0.5
    ),
    /HTTP 503/
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test("status write backoff applies bounded jitter", async () => {
  const waits: number[] = [];
  await assert.rejects(
    retryTransientStatusWrite(
      async () => {
        throw new Error("HTTP 503");
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
      2,
      () => 0
    ),
    /HTTP 503/
  );
  assert.deepEqual(waits, [125]);
});

test("status writes honor server retry delays and stop when they exceed the job budget", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await retryTransientStatusWrite(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("HTTP 429"), { retryAfterMs: 5_000 });
      }
      return "recovered";
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    3,
    () => 0
  );
  assert.equal(result, "recovered");
  assert.deepEqual(waits, [5_000]);

  calls = 0;
  waits.length = 0;
  await assert.rejects(
    retryTransientStatusWrite(
      async () => {
        calls += 1;
        throw Object.assign(new Error("HTTP 429"), { retryAfterMs: 60_001 });
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
      3,
      () => 0
    ),
    /HTTP 429/
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("status writes parse Retry-After and rate-limit reset headers", () => {
  assert.equal(responseRetryDelayMs(new Headers({ "Retry-After": "2.5" }), 1_000), 2_500);
  assert.equal(
    responseRetryDelayMs(new Headers({ "Retry-After": new Date(6_000).toUTCString() }), 1_000),
    5_000
  );
  assert.equal(responseRetryDelayMs(new Headers({ "X-RateLimit-Reset": "6" }), 1_000), 5_000);
  assert.equal(responseRetryDelayMs(new Headers(), 1_000), undefined);
});

const sampleStatus = {
  repository: "fongap-labs/dsh-plugin",
  sha: "a".repeat(40),
  token: "test-scoped-token",
  state: "success" as const,
  context: "Main Write Guard",
  description: "Signed status [test]",
  targetUrl: "https://github.com/fongap-labs/action-worker/actions/runs/123",
};

test("commit status POST accepts a confirmed HTTP 201 even with an empty JSON body", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    assert.match(String(url), /\/repos\/fongap-labs\/dsh-plugin\/statuses\/a{40}$/);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-scoped-token");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      state: "success",
      context: "Main Write Guard",
      description: "Signed status [test]",
      target_url: sampleStatus.targetUrl,
    });
    return new Response(null, { status: 201 });
  };
  try {
    await postGithubCommitStatus(sampleStatus);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("commit status POST retries a transient 502 but never a permission 403", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 502 }) : new Response(null, { status: 201 });
  };
  try {
    await postGithubCommitStatus(sampleStatus);
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 403 });
    };
    await assert.rejects(postGithubCommitStatus(sampleStatus), /HTTP 403.*Commit statuses: Write/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("commit status POST does not fall back when the scoped token is missing", async () => {
  await assert.rejects(
    postGithubCommitStatus({ ...sampleStatus, token: "" }),
    /missing dedicated status token/
  );
});

