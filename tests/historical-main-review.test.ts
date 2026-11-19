import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  type HistoricalMainReview,
  reconcileHistoricalMainGuards,
} from "../scripts/historical-main-review.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const repository = "fongap-labs/example";
const controlRepository = "fongap-labs/action-worker";
const originalSha = "a".repeat(40);
const headSha = "b".repeat(40);
const currentMain = "c".repeat(40);
const originalTitle = "fix(example): reproduce verified governance";
const governanceUrl = "https://github.com/fongap-labs/action-worker/actions/runs/31";
const evidenceUrl = "https://github.com/fongap-labs/action-worker/actions/runs/32";
const reviewUrl = "https://github.com/fongap-labs/action-worker/actions/runs/99";
const previousKeyring = process.env.AW_STATUS_KEYRING;
process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1,
  active: "k1",
  keys: { k1: Buffer.alloc(32, 7).toString("base64url") },
  legacy_tokens: [],
});

const review: HistoricalMainReview = {
  repository,
  merge_sha: originalSha,
  root_incident_sha: originalSha,
  pr_number: 7,
  approval_issue: 8,
};

function status(sha: string, context: string, targetUrl: string, state: "failure" | "success") {
  const description =
    context === "Main Write Guard"
      ? "Untrusted main write"
      : context === "CI Evidence"
        ? "CI evidence passed"
        : `title-sha256=${prTitleFingerprint(originalTitle)} governance passed`;
  return {
    context,
    state,
    target_url: targetUrl,
    created_at: "2026-11-19T00:29:50Z",
    description: signedStatusDescription({
      repository,
      sha,
      context,
      state,
      targetUrl,
      description,
    }),
  };
}

function run(id: number, conclusion: "success" | "failure") {
  return {
    id,
    conclusion,
    status: "completed",
    event: "repository_dispatch",
    path:
      id === 31
        ? ".github/workflows/handle-pr-dispatch.yml"
        : ".github/workflows/central-ci-dispatch.yml",
    repository: { full_name: controlRepository },
    head_branch: "main",
    run_started_at: "2026-11-19T00:28:00Z",
    updated_at: "2026-11-19T00:31:00Z",
  };
}

function makeReader(
  options: {
    failedGovernance?: boolean;
    incidentResolved?: boolean;
    invalidMergeStep?: boolean;
    priorSuccess?: boolean;
    wrongHead?: boolean;
  } = {}
) {
  const {
    failedGovernance = true,
    incidentResolved = true,
    invalidMergeStep = false,
    priorSuccess = false,
    wrongHead = false,
  } = options;
  return {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/commits/${originalSha}/status`) {
        return {
          statuses: [
            status(originalSha, "Main Write Guard", reviewUrl, priorSuccess ? "success" : "failure"),
          ],
        };
      }
      if (path === `repos/${repository}/compare/${originalSha}...${currentMain}`) {
        return { status: "ahead", merge_base_commit: { sha: originalSha } };
      }
      if (path === `repos/${repository}/issues/8`) {
        return {
          title: `Main write incident: ${originalSha.slice(0, 12)}`,
          state: "closed",
          body: `Main Write Audit rejected ${repository}@${originalSha}`,
        };
      }
      if (path === `repos/${repository}/issues/8/comments?per_page=100`) {
        return incidentResolved ? [{ body: "/resolve", author_association: "MEMBER" }] : [];
      }
      if (path === `repos/${repository}/pulls/7`) {
        return {
          number: 7,
          state: "closed",
          merged: true,
          title: originalTitle,
          merged_at: "2026-11-19T00:30:08Z",
          head: { sha: wrongHead ? "d".repeat(40) : headSha },
          base: { ref: "main" },
          merge_commit_sha: originalSha,
        };
      }
      if (path === `repos/${repository}/commits/${headSha}/status`) {
        return {
          statuses: [
            status(headSha, "PR Governance", governanceUrl, "success"),
            status(headSha, "CI Evidence", evidenceUrl, "success"),
            status(headSha, "validate-merge", governanceUrl, "success"),
          ],
        };
      }
      if (path === `repos/${controlRepository}/actions/runs/31`) {
        return run(31, failedGovernance ? "failure" : "success");
      }
      if (path === `repos/${controlRepository}/actions/runs/32`) {
        return run(32, "success");
      }
      if (path === `repos/${controlRepository}/actions/runs/31/jobs?per_page=100`) {
        return {
          jobs: [
            {
              name: "PR Governance",
              conclusion: "failure",
              steps: [
                { name: "Update final gate", conclusion: "success" },
                { name: "Update central merge gate", conclusion: "success" },
                {
                  name: invalidMergeStep
                    ? "Validate change record"
                    : "Automatically merge CI-green PR",
                  conclusion: "failure",
                  completed_at: "2026-11-19T00:30:10Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected API read: ${path}`);
    },
  };
}

async function reviewOne(options: Parameters<typeof makeReader>[0] = {}) {
  const written: Array<{ state: string; context: string; sha: string }> = [];
  const runReview = () =>
    reconcileHistoricalMainGuards(
      makeReader(options),
      repository,
      currentMain,
      controlRepository,
      "scoped-status-token",
      reviewUrl,
      [review],
      async (request) => {
        written.push(request);
      }
    );
  return { runReview, written };
}

test("a resolved historical incident with all signed gates and only a post-merge failure is safely re-attested", async () => {
  const { runReview, written } = await reviewOne();
  assert.deepEqual(await runReview(), [originalSha]);
  assert.deepEqual(
    written.map(({ state, context, sha }) => ({ state, context, sha })),
    [{ state: "success", context: "Main Write Guard", sha: originalSha }]
  );
});

test("successful historical governance run is also eligible after trusted resolution", async () => {
  const { runReview } = await reviewOne({ failedGovernance: false });
  assert.deepEqual(await runReview(), [originalSha]);
});

test("no historic rewrite without a trusted resolution or exactly verified failed step", async () => {
  for (const options of [
    { incidentResolved: false },
    { invalidMergeStep: true },
    { wrongHead: true },
  ]) {
    const { runReview, written } = await reviewOne(options);
    await assert.rejects(runReview(), /Historical main review denied/);
    assert.deepEqual(written, []);
  }
});

test("a previously signed success is never posted twice", async () => {
  const { runReview, written } = await reviewOne({ priorSuccess: true });
  assert.deepEqual(await runReview(), []);
  assert.deepEqual(written, []);
});

after(() => {
  if (previousKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = previousKeyring;
});
