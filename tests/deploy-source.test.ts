import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertExpectedRepository,
  hasTrustedCiEvidence,
  parseDeployRequest,
} from "../scripts/validate-deploy-source.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("deploy dispatch is exact and repository binding is executor-owned", () => {
  const request = {
    schema_version: "1",
    request_id: "deploy-123",
    source_repository: "fongap-labs/example",
    source_sha: sha,
  };
  const parsed = parseDeployRequest(request);
  assert.deepEqual(parsed, request);
  assert.doesNotThrow(() => assertExpectedRepository(parsed, ""));
  assert.doesNotThrow(() => assertExpectedRepository(parsed, "fongap-labs/example"));
  assert.throws(() => assertExpectedRepository(parsed, "fongap-labs/other"));
  assert.throws(() => parseDeployRequest({ ...request, extra: true }));
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
