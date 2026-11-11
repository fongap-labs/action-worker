import assert from "node:assert/strict";
import { test } from "node:test";
import { sleep } from "../scripts/lib/promise-delay-runtime.ts";

test("shared polling delay resolves as a void Promise", async () => {
  const result = await sleep(0);
  assert.equal(result, undefined);
});
