import assert from "node:assert/strict";
import { after, test } from "node:test";
import { assertReadyForAutomaticMerge, isOpenDraftPull, mustRefreshBehindBranch } from "../scripts/auto-merge-pr.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const repository = "fongap-labs/ai-gateway";
const number = 343;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const runUrl = "https://github.com/fongap-labs/action-worker/actions/runs/42769598813";
const ciUrl = "https://github.com/fongap-labs/action-worker/actions/runs/42769690716";

const previousKeyring = process.env.AW_STATUS_KEYRING;
process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1,
  active: "k1",
  keys: { k1: Buffer.alloc(32, 7).toString("base64url") },
  legacy_tokens: [],
});

function pull() {
  return {
    state: "open",
    number,
    merged: false,
    draft: false,
    head: { sha: headSha },
    base: { sha: baseSha, ref: "main" },
  };
}

function status(
  context: string,
  state: "success" | "pending" | "failure" = "success",
  targetUrl = runUrl,
  createdAt = "2026-11-10T07:00:00Z"
) {
  return {
    context,
    state,
    target_url: targetUrl,
    created_at: createdAt,
    description: signedStatusDescription({
      repository,
      sha: headSha,
      state,
      context,
      description: "Central CI gate verdict",
      targetUrl,
    }),
  };
}

function statuses() {
  return {
    statuses: [
      status("PR Governance"),
      status("CI Evidence", "success", ciUrl),
      status("validate-merge"),
    ],
  };
}

function verify(candidatePull: unknown, candidateStatuses: unknown) {
  return assertReadyForAutomaticMerge(
    candidatePull,
    candidateStatuses,
    repository,
    number,
    headSha,
    baseSha,
    runUrl
  );
}

test("signed current-head CI success authorizes zero-review automatic squash merge", () => {
  assert.doesNotThrow(() => verify(pull(), statuses()));
});

test("only a same-repository behind branch may be refreshed after signed CI succeeds", () => {
  const behind = {
    ...pull(),
    mergeable_state: "behind",
    head: { sha: headSha, repo: { full_name: repository } },
    base: { sha: baseSha, ref: "main", repo: { full_name: repository } },
  };
  assert.doesNotThrow(() => verify(behind, statuses()));
  assert.equal(mustRefreshBehindBranch(behind, repository), true);
  assert.equal(mustRefreshBehindBranch({ ...behind, mergeable_state: "clean" }, repository), false);
  assert.equal(
    mustRefreshBehindBranch(
      { ...behind, head: { sha: headSha, repo: { full_name: "someone/fork" } } },
      repository
    ),
    false
  );
  assert.equal(
    mustRefreshBehindBranch(
      { ...behind, base: { sha: baseSha, ref: "main", repo: { full_name: "someone/fork" } } },
      repository
    ),
    false
  );
});

test("Draft PR is a deliberate no-op, not merge admission", () => {
  const draft = { ...pull(), draft: true };
  assert.equal(isOpenDraftPull(draft, number), true);
  assert.throws(() => verify(draft, statuses()), /non-draft/);
  assert.equal(isOpenDraftPull({ ...draft, number: number + 1 }, number), false);
  assert.equal(isOpenDraftPull({ ...draft, merged: true }, number), false);
  assert.equal(isOpenDraftPull({ ...draft, state: "closed" }, number), false);
  assert.equal(isOpenDraftPull(pull(), number), false);
});

test("draft and changed or closed PRs never auto-merge", () => {
  for (const altered of [
    { ...pull(), draft: true },
    { ...pull(), state: "closed" },
    { ...pull(), merged: true },
    { ...pull(), number: 344 },
    { ...pull(), head: { sha: "c".repeat(40) } },
    { ...pull(), base: { sha: "c".repeat(40), ref: "main" } },
    { ...pull(), base: { sha: baseSha, ref: "legacy/v0.1.5" } },
  ])
    assert.throws(() => verify(altered, statuses()));
});

test("every signed deterministic gate is mandatory, not the AI review", () => {
  for (const gate of ["PR Governance", "CI Evidence", "validate-merge"]) {
    for (const state of ["pending", "failure"] as const) {
      const values = statuses();
      values.statuses = values.statuses.map((item) =>
        item.context === gate ? status(gate, state, gate === "CI Evidence" ? ciUrl : runUrl) : item
      );
      assert.throws(() => verify(pull(), values), /signed success/);
    }
    const values = statuses();
    values.statuses = values.statuses.filter((item) => item.context !== gate);
    assert.throws(() => verify(pull(), values), /signed success/);
  }
});

test("stale, unsigned, or foreign governance proof blocks merging", () => {
  const mismatched = statuses();
  mismatched.statuses[0] = status(
    "PR Governance",
    "success",
    "https://github.com/fongap-labs/action-worker/actions/runs/777"
  );
  assert.throws(() => verify(pull(), mismatched), /another governance run/);

  const newerUnsigned = statuses();
  newerUnsigned.statuses.unshift({
    ...status("validate-merge", "success", runUrl, "2026-11-10T07:01:00Z"),
    description: "unsigned green check",
  });
  assert.throws(() => verify(pull(), newerUnsigned), /signed success/);

  const missingSignature = statuses();
  missingSignature.statuses[1] = { ...missingSignature.statuses[1]!, description: "fake success" };
  assert.throws(() => verify(pull(), missingSignature), /signed success/);
});

test("merge readiness rejects malformed repository, SHA and governance run URL", () => {
  const r = pull();
  const s = statuses();
  assert.throws(() =>
    assertReadyForAutomaticMerge(r, s, "../outside", number, headSha, baseSha, runUrl)
  );
  assert.throws(() =>
    assertReadyForAutomaticMerge(r, s, repository, number, "main", baseSha, runUrl)
  );
  assert.throws(() =>
    assertReadyForAutomaticMerge(
      r,
      s,
      repository,
      number,
      headSha,
      baseSha,
      "https://example.com/forged"
    )
  );
});

after(() => {
  if (previousKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = previousKeyring;
});
