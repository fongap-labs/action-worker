import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hasVerifiedControlStatus } from "../scripts/ci-evidence.ts";
import {
  hasValidStatusAttestation,
  signedStatusDescription,
} from "../scripts/status-attestation.ts";

const subject = {
  repository: "fongap-labs/ai-gateway",
  sha: "75f3a5c59ca0800395b07f55a913224fde87f3f1",
  context: "PR Governance",
};
const receipt = {
  id: 57943435163,
  context: subject.context,
  state: "success",
  description: "Action Worker PR governance passed",
  target_url: "https://github.com/fongap-labs/action-worker/actions/runs/41648017125",
  created_at: "2026-11-03T13:53:00Z",
};
const token = "migration-test-status-token";

test("the closed migration contains 21 unique SHA-256 receipts from before signing", () => {
  const policy = JSON.parse(
    readFileSync(new URL("../policies/status-migration.json", import.meta.url), "utf8")
  );
  assert.equal(policy.schema_version, 1);
  assert.equal(policy.recorded_before, "2026-11-03T21:29:15Z");
  assert.equal(policy.fingerprints.length, 21);
  assert.equal(new Set(policy.fingerprints).size, 21);
  for (const digest of policy.fingerprints) assert.match(digest, /^[0-9a-f]{64}$/);
});

test("a recorded pre-signing status is recognized only for its exact subject and payload", () => {
  assert.equal(hasValidStatusAttestation(receipt, subject, token), true);
  for (const changed of [
    { id: receipt.id + 1 },
    { id: undefined },
    { state: "failure" },
    { state: "pending" },
    { description: "Forged success" },
    { context: "validate-merge" },
    { target_url: `${receipt.target_url}0` },
    { created_at: "2026-11-03T13:53:01Z" },
    { created_at: "2026-11-04T00:00:00Z" },
    { created_at: undefined },
    { description: `${receipt.description} [aw1:${"a".repeat(43)}]` },
  ])
    assert.equal(
      hasValidStatusAttestation({ ...receipt, ...changed }, subject, token),
      false,
      JSON.stringify(changed)
    );
  assert.equal(
    hasValidStatusAttestation(receipt, { ...subject, repository: "fongap-labs/other" }, token),
    false
  );
  assert.equal(
    hasValidStatusAttestation(receipt, { ...subject, sha: "a".repeat(40) }, token),
    false
  );
  assert.equal(hasValidStatusAttestation(receipt, subject, ""), false);
});

test("unrecorded unsigned statuses remain rejected while new signed statuses work", () => {
  const status = { ...receipt, id: receipt.id + 1, created_at: "2026-11-04T00:00:00Z" };
  assert.equal(hasValidStatusAttestation(status, subject, token), false);
  const description = signedStatusDescription(
    {
      ...subject,
      state: "success",
      description: receipt.description,
      targetUrl: receipt.target_url,
    },
    token
  );
  assert.equal(hasValidStatusAttestation({ ...status, description }, subject, token), true);
  assert.equal(
    hasValidStatusAttestation({ ...status, description }, subject, "wrong-token"),
    false
  );
});

test("a migrated status still requires the original successful publishing run and time window", async () => {
  const run = {
    repository: { full_name: "fongap-labs/action-worker" },
    path: ".github/workflows/handle-pr-dispatch.yml",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-03T13:50:53Z",
    updated_at: "2026-11-03T13:53:12Z",
  };
  const verify = (changed: Record<string, unknown>) =>
    hasVerifiedControlStatus(
      {
        async get() {
          return { ...run, ...changed };
        },
      },
      { statuses: [receipt] },
      subject.context,
      {
        targetRepository: subject.repository,
        targetSha: subject.sha,
        statusToken: token,
        retryDelayMs: 0,
      }
    );
  assert.equal(await verify({}), true);
  for (const changed of [
    { conclusion: "failure" },
    { head_branch: "other" },
    { path: ".github/workflows/intake.yml" },
    { repository: { full_name: "attacker/fork" } },
    { run_started_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T01:00:00Z" },
  ])
    assert.equal(await verify(changed), false, JSON.stringify(changed));
});
