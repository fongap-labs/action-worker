import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasTrustedCiEvidence,
  parseDeployRequest,
} from "../scripts/validate-deploy-source.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("deploy dispatch is exact and repository-bound", () => {
  const request = {
    schema_version: "1",
    request_id: "deploy-123",
    source_repository: "fongap-labs/ai-gateway",
    source_sha: sha,
  };
  assert.deepEqual(parseDeployRequest(request, "fongap-labs/ai-gateway"), request);
  assert.throws(() => parseDeployRequest(
    { ...request, source_repository: "fongap-labs/internal-vault" },
    "fongap-labs/ai-gateway",
  ));
  assert.throws(() => parseDeployRequest({ ...request, extra: true }, "fongap-labs/ai-gateway"));
});

test("deploy evidence must be successful Action Worker CI Evidence", () => {
  const trusted = {
    statuses: [{
      context: "CI Evidence",
      state: "success",
      target_url: "https://github.com/fongap-labs/action-worker/actions/runs/123",
    }],
  };
  assert.equal(hasTrustedCiEvidence(trusted), true);
  assert.equal(hasTrustedCiEvidence({
    statuses: [{ ...trusted.statuses[0], state: "failure" }],
  }), false);
  assert.equal(hasTrustedCiEvidence({
    statuses: [{ ...trusted.statuses[0], target_url: "https://example.invalid/run/123" }],
  }), false);
  assert.equal(hasTrustedCiEvidence({
    statuses: [{ ...trusted.statuses[0], context: "ci-evidence" }],
  }), false);
});
