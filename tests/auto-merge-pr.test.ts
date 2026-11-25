import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  assertCurrentMergeCiScope,
  assertReadyForAutomaticMerge,
  authorizeAdvancedBaseRefresh,
  isApprovedCompletedMerge,
  isOpenDraftPull,
  mustRefreshBehindBranch,
  waitForApprovedCompletedMerge,
} from "../scripts/auto-merge-pr.ts";
import { prCiScopeDescription } from "../scripts/ci-scope-receipt.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const repository = "fongap-labs/ai-gateway";
const number = 343;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const prTitle = "feat(example): add a feature";
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
    title: prTitle,
    head: { sha: headSha },
    base: { sha: baseSha, ref: "main" },
  };
}

function status(
  context: string,
  state: "success" | "pending" | "failure" = "success",
  targetUrl = runUrl,
  createdAt = "2026-11-10T07:00:00Z",
  descriptionOverride?: string
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
      description:
        descriptionOverride ??
        (context === "CI Evidence"
          ? "Central CI gate verdict"
          : "title-sha256=" + prTitleFingerprint(prTitle) + " Central CI gate verdict"),
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

test("managed branch transfers cannot reuse signed ordinary merge gates", () => {
  for (const ref of ["main", "dev"]) {
    const candidate = {
      ...pull(),
      mergeable_state: "behind",
      head: { sha: headSha, ref, repo: { full_name: repository } },
      base: { sha: baseSha, ref: "main", repo: { full_name: repository } },
    };
    assert.throws(() => verify(candidate, statuses()), /human authorization/);
    assert.equal(mustRefreshBehindBranch(candidate, repository), false);
    assert.equal(
      authorizeAdvancedBaseRefresh(
        { ...candidate, base: { ...candidate.base, sha: "d".repeat(40) } },
        statuses(),
        repository,
        number,
        headSha,
        baseSha,
        runUrl
      ),
      false
    );
    assert.equal(
      isApprovedCompletedMerge(
        {
          ...candidate,
          state: "closed",
          merged: true,
          merged_at: "2026-11-12T03:55:19Z",
          merge_commit_sha: "c".repeat(40),
        },
        statuses(),
        repository,
        number,
        headSha,
        baseSha,
        runUrl
      ),
      false
    );
  }
});

test("trusted governance run URL follows the configured control repository", () => {
  const control = "example-org/control-plane";
  const url = "https://github.com/" + control + "/actions/runs/123";
  const customStatuses = {
    statuses: [
      status("PR Governance", "success", url),
      status("CI Evidence", "success", ciUrl),
      status("validate-merge", "success", url),
    ],
  };
  assert.doesNotThrow(() =>
    assertReadyForAutomaticMerge(
      pull(),
      customStatuses,
      repository,
      number,
      headSha,
      baseSha,
      url,
      control
    )
  );
});

test("signed no-CI gate verdict remains admissible for automatic merge", () => {
  const noCiStatuses = {
    statuses: [
      status("PR Governance"),
      status(
        "CI Evidence",
        "success",
        ciUrl,
        "2026-11-10T07:00:00Z",
        "CI not run: the governance plan does not require CI"
      ),
      status("validate-merge"),
    ],
  };
  assert.doesNotThrow(() => verify(pull(), noCiStatuses));
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

test("a behind PR whose main advanced during CI may only refresh its head", () => {
  const behind = {
    ...pull(),
    mergeable_state: "behind",
    head: { sha: headSha, repo: { full_name: repository } },
    base: { sha: "d".repeat(40), ref: "main", repo: { full_name: repository } },
  };
  // Old-base evidence cannot directly merge the new base.
  assert.throws(() => verify(behind, statuses()), /revalidate first/);
  assert.equal(
    authorizeAdvancedBaseRefresh(behind, statuses(), repository, number, headSha, baseSha, runUrl),
    true
  );
  for (const bad of [
    { ...behind, mergeable_state: "dirty" },
    { ...behind, mergeable_state: "clean" },
    { ...behind, draft: true },
    { ...behind, state: "closed" },
    { ...behind, number: number + 1 },
    { ...behind, head: { sha: "c".repeat(40), repo: { full_name: repository } } },
    { ...behind, head: { sha: headSha, repo: { full_name: "someone/fork" } } },
    { ...behind, base: { sha: "d".repeat(40), ref: "other", repo: { full_name: repository } } },
    { ...behind, base: { sha: baseSha, ref: "main", repo: { full_name: repository } } },
  ]) {
    assert.equal(
      authorizeAdvancedBaseRefresh(bad, statuses(), repository, number, headSha, baseSha, runUrl),
      false
    );
  }
  const unsigned = statuses();
  unsigned.statuses[0] = { ...unsigned.statuses[0]!, description: "forged" };
  assert.throws(
    () =>
      authorizeAdvancedBaseRefresh(behind, unsigned, repository, number, headSha, baseSha, runUrl),
    /signed success/
  );
  const changedTitle = { ...behind, title: "fix(example): changed while testing" };
  assert.throws(
    () =>
      authorizeAdvancedBaseRefresh(
        changedTitle,
        statuses(),
        repository,
        number,
        headSha,
        baseSha,
        runUrl
      ),
    /current PR title/
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

test("automatic merge refuses a PR title changed after its signed governance verdict", () => {
  assert.throws(
    () => verify({ ...pull(), title: "fix(example): repair a bug" }, statuses()),
    /current PR title/
  );
});

test("exact approved merged PR is an idempotent success, never an authorization bypass", () => {
  const approved = {
    ...pull(),
    state: "closed",
    merged: true,
    merged_at: "2026-11-12T03:55:19Z",
    merge_commit_sha: "c".repeat(40),
  };
  const verifyMerge = (v: unknown, s = statuses()) =>
    isApprovedCompletedMerge(v, s, repository, number, headSha, baseSha, runUrl);
  assert.equal(verifyMerge(approved), true);
  // GitHub updates base.sha to the latest main tip after an otherwise valid merge.
  // The original base is still enforced for open PRs, not for completed ones.
  const advancedBase = { ...approved, base: { sha: "d".repeat(40), ref: "main" } };
  assert.equal(verifyMerge(advancedBase), true);
  assert.throws(
    () => verify({ ...pull(), base: advancedBase.base }, statuses()),
    /revalidate first/
  );
  for (const invalid of [
    { ...approved, merged: false },
    { ...approved, state: "open" },
    { ...approved, merged_at: null },
    { ...approved, merge_commit_sha: null },
    { ...approved, number: number + 1 },
    { ...approved, head: { sha: "d".repeat(40) } },
    { ...approved, base: { sha: "d".repeat(40), ref: "not-main" } },
    { ...approved, merged_at: "2026-11-09T03:55:19Z" },
    { ...approved, merged_at: "not-a-timestamp" },
    { ...approved, title: "fix: different title" },
  ]) {
    assert.equal(verifyMerge(invalid), false);
  }
  const tampered = statuses();
  tampered.statuses[0] = { ...tampered.statuses[0]!, description: "unsigned status" };
  assert.equal(verifyMerge(approved, tampered), false);
  const differentRun = statuses();
  differentRun.statuses[0] = status(
    "PR Governance",
    "success",
    "https://github.com/fongap-labs/action-worker/actions/runs/9999999"
  );
  assert.equal(verifyMerge(approved, differentRun), false);
});

test("concurrent already-approved merge is accepted after bounded stale PR snapshots", async () => {
  const approved = {
    ...pull(),
    state: "closed",
    merged: true,
    merged_at: "2026-11-12T03:55:19Z",
    merge_commit_sha: "c".repeat(40),
    base: { sha: "d".repeat(40), ref: "main" },
  };
  const observed = [pull(), pull(), approved];
  let readCount = 0;
  let waitCount = 0;
  const result = await waitForApprovedCompletedMerge(
    async () => observed[readCount++] ?? approved,
    statuses(),
    { repository, prNumber: number, headSha, baseSha, governanceRunUrl: runUrl },
    async () => {
      waitCount += 1;
    }
  );
  assert.equal(result, true);
  assert.equal(readCount, 3);
  assert.equal(waitCount, 2);
});

test("concurrent merge verification rejects wrong heads, missing proof and unmerged PRs", async () => {
  const approved = {
    ...pull(),
    state: "closed",
    merged: true,
    merged_at: "2026-11-12T03:55:19Z",
    merge_commit_sha: "c".repeat(40),
  };
  const identity = { repository, prNumber: number, headSha, baseSha, governanceRunUrl: runUrl };
  const incorrect = { ...approved, head: { sha: "d".repeat(40) } };
  let reads = 0;
  const wrong = await waitForApprovedCompletedMerge(
    async () => {
      reads += 1;
      return incorrect;
    },
    statuses(),
    identity,
    async () => {
      throw new Error("Wrong completed PR must not be polled");
    }
  );
  assert.equal(wrong, false);
  assert.equal(reads, 1);

  const unsigned = statuses();
  unsigned.statuses[0] = { ...unsigned.statuses[0]!, description: "forged" };
  assert.equal(
    await waitForApprovedCompletedMerge(
      async () => approved,
      unsigned,
      identity,
      async () => {}
    ),
    false
  );

  let attempts = 0;
  assert.equal(
    await waitForApprovedCompletedMerge(
      async () => {
        attempts += 1;
        return pull();
      },
      statuses(),
      identity,
      async () => {}
    ),
    false
  );
  assert.equal(attempts, 5);

  await assert.rejects(
    waitForApprovedCompletedMerge(
      async () => pull(),
      statuses(),
      identity,
      async () => {},
      6
    ),
    /Invalid bounded/
  );
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

test("final merge admission requires signed evidence for the live snapshot", async () => {
  const scope = {
    repository,
    prNumber: number,
    targetBranch: "main",
    baseSha,
    headSha,
    mergeSha: "c".repeat(40),
  };
  const prefix = `repos/${repository}`;
  const responses = new Map<string, unknown>([
    [
      `${prefix}/pulls/${number}`,
      {
        ...pull(),
        head: { sha: headSha, ref: "fix/example" },
        base: { sha: baseSha, ref: "main", repo: { full_name: repository } },
      },
    ],
    [`${prefix}/branches/main`, { commit: { sha: baseSha } }],
    [`${prefix}/git/ref/pull/${number}/merge`, { object: { sha: scope.mergeSha } }],
    [
      `${prefix}/git/commits/${scope.mergeSha}`,
      { sha: scope.mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] },
    ],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(responses.has(path), path);
      return responses.get(path);
    },
  };
  const signedEvidence = (description: string) => ({
    statuses: [status("CI Evidence", "success", ciUrl, undefined, description)],
  });
  const verifyScope = (candidate: unknown) =>
    assertCurrentMergeCiScope(reader, candidate, repository, number, headSha, baseSha);
  await assert.doesNotReject(verifyScope(signedEvidence(prCiScopeDescription(scope))));
  for (const description of [
    "Central CI gate verdict",
    prCiScopeDescription({ ...scope, targetBranch: "dev" }),
    prCiScopeDescription({ ...scope, prNumber: number + 1 }),
    prCiScopeDescription({ ...scope, baseSha: "d".repeat(40) }),
    prCiScopeDescription({ ...scope, mergeSha: "e".repeat(40) }),
  ]) {
    await assert.rejects(verifyScope(signedEvidence(description)), /CI snapshot scope changed/);
  }
  responses.set(`${prefix}/branches/main`, { commit: { sha: "f".repeat(40) } });
  await assert.rejects(
    verifyScope(signedEvidence(prCiScopeDescription(scope))),
    /CI snapshot scope changed/
  );
});

after(() => {
  if (previousKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = previousKeyring;
});
