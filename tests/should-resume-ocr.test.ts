import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeDelayMs, shouldResume } from "../scripts/should-resume-ocr.ts";

function failedReview(status: number, retryAfterMs: number, errorClass = "rate_limited") {
  return {
    status: "failed",
    session_id: "test-session",
    retry_report: {
      schema_version: "ocr.llm-retry-report/v1",
      requests: [
        {
          outcome: "failed",
          attempts: [
            {
              attempt: 3,
              outcome: "error",
              status_code: status,
              retry_after_ms: retryAfterMs,
              error_class: errorClass,
            },
          ],
        },
      ],
    },
  };
}

test("OCR can resume short rate limits after exhausted internal request retries", () => {
  assert.equal(shouldResume(failedReview(429, 30_000)), true);
  assert.equal(shouldResume(failedReview(429, 120_000)), true);
});

test("OCR does not resume indefinite rate limits or invalid credentials", () => {
  assert.equal(shouldResume(failedReview(429, 0)), false);
  assert.equal(shouldResume(failedReview(429, 300_000)), false);
  assert.equal(shouldResume(failedReview(401, 1000)), false);
  assert.equal(shouldResume(failedReview(403, 1000)), false);
  assert.equal(shouldResume(failedReview(400, 1000)), false);
});

test("OCR keeps transient network/overload resumes and requires valid session evidence", () => {
  assert.equal(shouldResume(failedReview(503, 0, "overloaded")), true);
  assert.equal(shouldResume(failedReview(0, 0, "network")), true);
  const invalid = failedReview(429, 1000);
  invalid.session_id = "";
  assert.equal(shouldResume(invalid), false);
  assert.equal(shouldResume({ ...failedReview(429, 1000), retry_report: {} }), false);
});

test("OCR session resume waits at least the short provider Retry-After", () => {
  assert.equal(resumeDelayMs(failedReview(429, 30_000), 15_000), 30_000);
  assert.equal(resumeDelayMs(failedReview(429, 5000), 15_000), 15_000);
  assert.equal(resumeDelayMs(failedReview(429, 120_000), 15_000), 120_000);
  assert.equal(resumeDelayMs(failedReview(503, 30_000), 15_000), 15_000);
  assert.equal(resumeDelayMs(undefined, 15_000), 15_000);
});
