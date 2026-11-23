import assert from "node:assert/strict";
import { after, test } from "node:test";
import { hasValidStatusAttestation, signedStatusDescription } from "../scripts/status-attestation.ts";

const saved = process.env.AW_STATUS_KEYRING;
process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1, active: "k1",
  keys: { k1: Buffer.alloc(32, 12).toString("base64url") }, legacy_tokens: [],
});
const head = "d57194f2bef6ed7eb5e6da7a2851a2d55f527132";
const url = "https://github.com/fongap-labs/action-worker/actions/runs/45110520298";
const renamed = "fongap-labs/plugins";
const original = "fongap-labs/dsh-plugin";
function oldStatus(context: string, created_at = "2026-11-23T04:13:58Z") {
  return {
    state: "success", context, created_at, target_url: url,
    description: signedStatusDescription({
      repository: original, sha: head, state: "success", context,
      description: "original signed source gate", targetUrl: url,
    }),
  };
}
test("renamed repository validates only original pre-rename SHA-pinned signed gates", () => {
  for (const context of ["PR Governance", "CI Evidence", "validate-merge"]) {
    const status = oldStatus(context);
    assert.equal(hasValidStatusAttestation(status, { repository: renamed, sha: head, context }), true);
    assert.equal(hasValidStatusAttestation(status, { repository: original, sha: head, context }), true);
    assert.equal(hasValidStatusAttestation(status, { repository: "fongap-labs/other", sha: head, context }), false);
    assert.equal(hasValidStatusAttestation(status, { repository: renamed, sha: "a".repeat(40), context }), false);
    assert.equal(hasValidStatusAttestation({ ...status, created_at: "2026-11-23T05:00:00Z" }, { repository: renamed, sha: head, context }), false);
    assert.equal(hasValidStatusAttestation({ ...status, target_url: url + "/forged" }, { repository: renamed, sha: head, context }), false);
    assert.equal(hasValidStatusAttestation({ ...status, state: "failure" }, { repository: renamed, sha: head, context }), false);
  }
  assert.equal(hasValidStatusAttestation(oldStatus("Main Write Guard"), { repository: renamed, sha: head, context: "Main Write Guard" }), false);
});
after(() => {
  if (saved === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = saved;
});
