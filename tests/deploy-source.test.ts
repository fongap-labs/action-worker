import assert from "node:assert/strict";
import { test } from "node:test";
import { requireVerifiedCiEvidence } from "../scripts/ci-evidence.ts";
import { assertExpectedRepository, parseDeployRequest } from "../scripts/validate-deploy-source.ts";

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

test("deploy evidence must be verified against a successful Action Worker CI run", async () => {
  const deploySha = "b".repeat(40);
  const statusPath = `repos/fongap-labs/example/commits/${deploySha}/status`;
  const status = {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        target_url: "https://github.com/fongap-labs/action-worker/actions/runs/123",
        created_at: "2026-10-02T13:11:43Z",
      },
    ],
  };
  const run = {
    repository: { full_name: "fongap-labs/action-worker" },
    path: ".github/workflows/central-ci-dispatch.yml",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-10-02T13:10:15Z",
    updated_at: "2026-10-02T13:11:57Z",
  };
  const readerFor = (payload: unknown, runValue: unknown) => ({
    get: async (path: string) => (path === statusPath ? payload : runValue),
  });

  await requireVerifiedCiEvidence(readerFor(status, run), "fongap-labs/example", deploySha);
  for (const [payload, runValue] of [
    [{ statuses: [{ ...status.statuses[0], state: "failure" }] }, run],
    [{ statuses: [{ ...status.statuses[0], target_url: "https://example.invalid/run/123" }] }, run],
    [{ statuses: [{ ...status.statuses[0], context: "ci-evidence" }] }, run],
    [status, { ...run, path: ".github/workflows/validate-ci.yml" }],
    [status, { ...run, conclusion: "failure" }],
  ] as const) {
    await assert.rejects(
      requireVerifiedCiEvidence(readerFor(payload, runValue), "fongap-labs/example", deploySha)
    );
  }
});
