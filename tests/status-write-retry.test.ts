import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRetryableStatusWriteError,
  postGithubCommitStatus,
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
    }
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
      }
    ),
    /HTTP 503/
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
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
