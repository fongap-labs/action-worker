import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRetryableStatusWriteError,
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
