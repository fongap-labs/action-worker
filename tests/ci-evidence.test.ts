import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasTrustedSuccessfulCiEvidence,
  latestCiStatus,
  trustedCiStatus,
  trustedControlRunId,
} from "../scripts/ci-evidence.ts";

const controlRepository = "fongap-labs/action-worker";

test("trusted control run URLs are exact and repository-scoped", () => {
  assert.equal(
    trustedControlRunId(
      "https://github.com/fongap-labs/action-worker/actions/runs/123",
      controlRepository,
    ),
    123,
  );
  assert.equal(
    trustedControlRunId(
      "https://github.com/fongap-labs/other/actions/runs/123",
      controlRepository,
    ),
    null,
  );
  assert.equal(
    trustedControlRunId(
      "https://example.com/fongap-labs/action-worker/actions/runs/123",
      controlRepository,
    ),
    null,
  );
});

test("only the latest matching trusted CI status can satisfy the gate", () => {
  const response = {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        target_url: "https://github.com/attacker/repo/actions/runs/9",
      },
      {
        context: "CI Evidence",
        state: "success",
        target_url: "https://github.com/fongap-labs/action-worker/actions/runs/8",
      },
    ],
  };
  assert.equal(latestCiStatus(response, "CI Evidence")?.state, "success");
  assert.equal(trustedCiStatus(response, "CI Evidence", controlRepository), undefined);
  assert.equal(
    hasTrustedSuccessfulCiEvidence(response, "CI Evidence", controlRepository),
    false,
  );
});

test("trusted successful CI evidence is idempotent", () => {
  const response = {
    statuses: [{
      context: "CI Evidence",
      state: "success",
      target_url: "https://github.com/fongap-labs/action-worker/actions/runs/42",
    }],
  };
  assert.equal(
    hasTrustedSuccessfulCiEvidence(response, "CI Evidence", controlRepository),
    true,
  );
});
