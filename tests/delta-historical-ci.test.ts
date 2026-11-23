import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  needsReviewedDeltaCi,
  reviewedDeltaCiCase,
  reviewedDeltaCiCases,
  verifyReviewedDeltaCiTarget,
} from "../scripts/delta-historical-ci.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const repository = "fongap-labs/delta";
const control = "fongap-labs/action-worker";
const originalKeyring = process.env.AW_STATUS_KEYRING;
process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1,
  active: "k1",
  keys: { k1: Buffer.alloc(32, 19).toString("base64url") },
  legacy_tokens: [],
});

const pinned = reviewedDeltaCiCases[2];
const runUrl = "https://github.com/fongap-labs/action-worker/actions/runs/31";
const currentControl = "f".repeat(40);
const oldControl = "e".repeat(40);
const reviewedGuard = {
  context: "Main Write Guard",
  state: "success",
  target_url: runUrl,
  description: signedStatusDescription({
    repository,
    sha: pinned.sha,
    context: "Main Write Guard",
    state: "success",
    description: "Trusted main write via PR #88",
    targetUrl: runUrl,
  }),
};
const priorFailure = {
  context: "CI Evidence",
  state: "failure",
  target_url: runUrl,
  description: signedStatusDescription({
    repository,
    sha: pinned.sha,
    context: "CI Evidence",
    state: "failure",
    description: "historical old control failure",
    targetUrl: runUrl,
  }),
};

test("only the three exact historical Delta SHA receipts may enter retest", () => {
  assert.equal(reviewedDeltaCiCases.length, 3);
  for (const item of reviewedDeltaCiCases) {
    assert.equal(reviewedDeltaCiCase(repository, item.sha)?.pr, item.pr);
    assert.equal(reviewedDeltaCiCase("fongap-labs/other", item.sha), undefined);
  }
  assert.equal(reviewedDeltaCiCase(repository, "a".repeat(40)), undefined);
});

function mockReader({
  guard = reviewedGuard,
  ci = priorFailure,
  runHead = oldControl,
  resolved = true,
}: {
  guard?: typeof reviewedGuard;
  ci?: typeof priorFailure;
  runHead?: string;
  resolved?: boolean;
} = {}) {
  return {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/commits/${pinned.sha}`) {
        return { sha: pinned.sha, parents: [{ sha: pinned.parent }] };
      }
      if (path === `repos/${repository}/issues/87`) {
        return {
          state: "closed",
          title: "Main write incident: b6e23bae4397",
          body: "b6e23bae43976e28b7c3f46c6b65041900a777be",
        };
      }
      if (path === `repos/${repository}/issues/87/comments?per_page=100`) {
        return resolved ? [{ body: "/resolve", author_association: "OWNER" }] : [];
      }
      if (path === `repos/${repository}/commits/${pinned.sha}/status`) {
        return { statuses: [guard, ci] };
      }
      if (path === `repos/${control}/actions/runs/31`) {
        return {
          status: "completed",
          head_branch: "main",
          head_sha: runHead,
          path: ".github/workflows/central-ci-dispatch.yml",
          repository: { full_name: control },
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
}

test("reviewed historical CI requires a signed main guard and maintainer incident resolution", async () => {
  assert.equal(
    await verifyReviewedDeltaCiTarget(mockReader(), repository, pinned.sha, pinned.sha),
    true
  );
  await assert.rejects(
    verifyReviewedDeltaCiTarget(mockReader({ resolved: false }), repository, pinned.sha, pinned.sha),
    /explicit trusted maintainer/
  );
  await assert.rejects(
    verifyReviewedDeltaCiTarget(
      mockReader({ guard: { ...reviewedGuard, state: "failure" } }),
      repository,
      pinned.sha,
      pinned.sha
    ),
    /verified, approved main-write guard/
  );
});

test("only a prior control run may be re-tested; current failures and success are not retried", async () => {
  assert.equal(await needsReviewedDeltaCi(mockReader(), pinned.sha, currentControl), true);
  assert.equal(
    await needsReviewedDeltaCi(mockReader({ runHead: currentControl }), pinned.sha, currentControl),
    false
  );
  assert.equal(
    await needsReviewedDeltaCi(
      mockReader({
        ci: {
          ...priorFailure,
          state: "success",
          description: signedStatusDescription({
            repository,
            sha: pinned.sha,
            context: "CI Evidence",
            state: "success",
            description: "verified complete",
            targetUrl: runUrl,
          }),
        },
      }),
      pinned.sha,
      currentControl
    ),
    false
  );
});

after(() => {
  if (originalKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = originalKeyring;
});
