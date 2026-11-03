import assert from "node:assert/strict";
import { test } from "node:test";
import { requireIntakeStatusToken } from "../scripts/intake-status-token.ts";

test("intake requires dedicated AW_STATUS_TOKEN with no fallback", () => {
  assert.throws(
    () => requireIntakeStatusToken(""),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("AW_STATUS_TOKEN") &&
      error.message.includes("Commit statuses: Read and write") &&
      error.message.includes("No token fallback")
  );
});

test("intake accepts a configured dedicated status token", () => {
  assert.equal(requireIntakeStatusToken("configured"), "configured");
});
