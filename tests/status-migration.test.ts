import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1,
  active: "test",
  keys: { test: Buffer.alloc(32, 11).toString("base64url") },
  legacy_tokens: [token],
});

function signedAw1StatusDescription(status: typeof receipt, signingToken: string): string {
  const message = JSON.stringify([
    "action-worker-status-v1",
    subject.repository.toLowerCase(),
    subject.sha.toLowerCase(),
    status.context,
    status.state,
    status.description,
    status.target_url,
  ]);
  const signature = createHmac("sha256", signingToken).update(message).digest("base64url");
  return `${status.description} [aw1:${signature}]`;
}

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
  assert.equal(hasValidStatusAttestation(receipt, subject), true);
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
      hasValidStatusAttestation({ ...receipt, ...changed }, subject),
      false,
      JSON.stringify(changed)
    );
  assert.equal(
    hasValidStatusAttestation(receipt, { ...subject, repository: "fongap-labs/other" }),
    false
  );
  assert.equal(hasValidStatusAttestation(receipt, { ...subject, sha: "a".repeat(40) }), false);
});

test("legacy aw1 and new aw2 signatures verify without a GitHub API token", () => {
  const status = { ...receipt, id: receipt.id + 1, created_at: "2026-11-04T00:00:00Z" };
  assert.equal(hasValidStatusAttestation(status, subject), false);
  const legacyDescription = signedAw1StatusDescription(status, token);
  assert.equal(
    hasValidStatusAttestation({ ...status, description: legacyDescription }, subject),
    true
  );
  const description = signedStatusDescription({
    ...subject,
    state: "success",
    description: receipt.description,
    targetUrl: receipt.target_url,
  });
  const originalStatusToken = process.env.AW_STATUS_TOKEN;
  process.env.AW_STATUS_TOKEN = "not-the-legacy-signing-key";
  try {
    assert.equal(hasValidStatusAttestation({ ...status, description }, subject), true);
    assert.equal(
      hasValidStatusAttestation({ ...status, description: legacyDescription }, subject),
      true
    );
  } finally {
    if (originalStatusToken === undefined) delete process.env.AW_STATUS_TOKEN;
    else process.env.AW_STATUS_TOKEN = originalStatusToken;
  }
});

test("a migrated status still requires the original successful publishing run and time window", async () => {
  const run = {
    id: 41648017125,
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
