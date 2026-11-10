import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CiFailureIdentity,
  ciFailureFingerprint,
  ciFailureMarker,
  ciFailureRetryDelayMs,
  parseCiFailureMarker,
  serverRetryAfterSeconds,
} from "../scripts/ci-failure-fingerprint.ts";

const identity: CiFailureIdentity = {
  targetRepository: "fongap-labs/example",
  workflow: ".github/workflows/central-ci-dispatch.yml",
  job: "Central CI / Linux (all)",
  step: "Run target tests",
  errorKind: "transient_network",
  sourceSha: "a".repeat(40),
  repairOperation: "central_ci_retry",
};

test("failure fingerprints use stable task facts and normalize simple formatting", () => {
  const fingerprint = ciFailureFingerprint(identity);
  assert.match(fingerprint, /^[0-9a-f]{62}$/);
  assert.equal(
    ciFailureFingerprint({ ...identity, job: " central   ci / linux (all) " }),
    fingerprint
  );
  assert.notEqual(ciFailureFingerprint({ ...identity, sourceSha: "b".repeat(40) }), fingerprint);
  assert.notEqual(ciFailureFingerprint({ ...identity, step: "Install dependencies" }), fingerprint);
  assert.notEqual(
    ciFailureFingerprint({ ...identity, repairOperation: "manual_fix" }),
    fingerprint
  );
});

test("only log-backed transient failures authorize a retry marker", () => {
  const context = {
    targetRepository: identity.targetRepository,
    workflow: identity.workflow,
    sourceSha: identity.sourceSha,
    repairOperation: identity.repairOperation,
  };
  const retryable = ciFailureMarker(
    [
      {
        job: identity.job,
        step: identity.step,
        kind: identity.errorKind,
        recoverability: "safe_retry",
        evidence: "job_log",
      },
    ],
    context,
    "HTTP 429 rate limit; Retry-After: 900"
  );
  const parsed = parseCiFailureMarker(retryable);
  assert.equal(parsed?.retryable, true);
  assert.equal(parsed?.retryAfterSeconds, 900);
  assert.match(parsed?.fingerprint ?? "", /^[0-9a-f]{62}$/);
  assert.equal(
    parseCiFailureMarker(
      ciFailureMarker(
        [
          {
            job: identity.job,
            step: identity.step,
            kind: identity.errorKind,
            recoverability: "safe_retry",
            evidence: "job_log",
          },
        ],
        context,
        "HTTP 429 rate limit; Retry-After: 900"
      )
    )?.fingerprint,
    parsed?.fingerprint
  );
  assert.equal(
    parseCiFailureMarker(
      ciFailureMarker(
        [
          {
            job: identity.job,
            step: identity.step,
            kind: "configuration",
            recoverability: "do_not_retry",
            evidence: "job_log",
          },
        ],
        context
      )
    )?.retryable,
    false
  );
  assert.equal(
    parseCiFailureMarker(
      ciFailureMarker(
        [
          {
            job: identity.job,
            step: identity.step,
            kind: "transient_network",
            recoverability: "unknown",
            evidence: "step_name",
          },
        ],
        context
      )
    )?.retryable,
    false
  );
});

test("Retry-After and rate-limit reset are parsed as delays, outside the fingerprint", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  assert.equal(serverRetryAfterSeconds("Retry-After: 120", now), 120);
  assert.equal(serverRetryAfterSeconds("Retry-After: 120\nRetry-After: 900", now), 900);
  assert.equal(serverRetryAfterSeconds("X-RateLimit-Reset: 1794270000", now), 1_200);
  assert.equal(serverRetryAfterSeconds("Retry-After: Tue, 10 Nov 2026 00:02:00 GMT", now), 120);
  assert.ok(ciFailureRetryDelayMs(2, `ff${"0".repeat(60)}`, 900) >= 900_000);
  assert.ok(ciFailureRetryDelayMs(2, `00${"0".repeat(60)}`, 0) >= 600_000);
});
