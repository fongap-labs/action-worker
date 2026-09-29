import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateReviewTarget } from "../scripts/check-review-target.ts";
import { buildReviewDispatch } from "../scripts/dispatch-pr-review.ts";
import { buildReview } from "../scripts/publish-pr-review.ts";
import { pullAllowsFacts } from "../scripts/resolve-pr-facts.ts";
import { validatePayload } from "../scripts/validate-pr-payload.ts";

const controlRepository = "fongap/control";
const headSha = "a".repeat(40);
const runUrl = `https://github.com/${controlRepository}/actions/runs/123`;

function pull(overrides: Record<string, unknown> = {}): unknown {
  return { state: "open", head: { sha: headSha }, ...overrides };
}

function statuses(...items: Array<Record<string, unknown>>): unknown {
  return { statuses: items };
}

test("AI review target is current only for the open head whose gate passed", () => {
  const passed = statuses({ context: "PR Governance", state: "success", target_url: runUrl });
  assert.deepEqual(evaluateReviewTarget(pull(), passed, headSha, controlRepository), {
    current: true,
    reason: "the gate passed for the current pull request head",
  });
});

test("AI review still runs for a pull request that was merged while it waited", () => {
  const passed = statuses({ context: "PR Governance", state: "success", target_url: runUrl });
  const merged = pull({ state: "closed", merged: true });
  assert.equal(evaluateReviewTarget(merged, passed, headSha, controlRepository).current, true);
  // The head and the gate are still checked, so a merged pull request gets no free pass.
  const moved = pull({ state: "closed", merged: true, head: { sha: "b".repeat(40) } });
  assert.equal(evaluateReviewTarget(moved, passed, headSha, controlRepository).current, false);
  assert.equal(evaluateReviewTarget(merged, statuses(), headSha, controlRepository).current, false);
});

test("pull request facts accept a merged pull request only when the caller opts in", () => {
  const open = { state: "open" };
  const merged = { state: "closed", merged: true };
  const abandoned = { state: "closed", merged: false };
  assert.equal(pullAllowsFacts(open, false), true);
  assert.equal(pullAllowsFacts(merged, false), false);
  assert.equal(pullAllowsFacts(merged, true), true);
  assert.equal(pullAllowsFacts(abandoned, true), false);
  assert.equal(pullAllowsFacts({ state: "closed" }, true), false);
  assert.equal(pullAllowsFacts(undefined, true), false);
});

test("AI review target is rejected when the pull request moved or was abandoned", () => {
  const passed = statuses({ context: "PR Governance", state: "success", target_url: runUrl });
  assert.match(
    evaluateReviewTarget(
      pull({ state: "closed", merged: false }),
      passed,
      headSha,
      controlRepository
    ).reason,
    /closed without merging/
  );
  assert.match(
    evaluateReviewTarget(
      pull({ head: { sha: "b".repeat(40) } }),
      passed,
      headSha,
      controlRepository
    ).reason,
    /head changed/
  );
  assert.equal(evaluateReviewTarget(undefined, passed, headSha, controlRepository).current, false);
});

test("AI review target never trusts a gate status that is not a central success", () => {
  const rejected = [
    statuses(),
    statuses({ context: "PR Governance", state: "pending", target_url: runUrl }),
    statuses({ context: "PR Governance", state: "failure", target_url: runUrl }),
    statuses({
      context: "PR Governance",
      state: "success",
      target_url: "https://github.com/attacker/repo/actions/runs/123",
    }),
    statuses({ context: "PR Governance", state: "success", target_url: "" }),
    statuses({ context: "CI Evidence", state: "success", target_url: runUrl }),
  ];
  for (const status of rejected) {
    assert.equal(
      evaluateReviewTarget(pull(), status, headSha, controlRepository).current,
      false,
      JSON.stringify(status)
    );
  }
});

test("AI review dispatch builds a payload the shared PR payload contract accepts", () => {
  const body = JSON.parse(buildReviewDispatch("fongap/example", "42", "review-9-1", headSha)) as {
    event_type: string;
    client_payload: Record<string, unknown>;
  };
  assert.equal(body.event_type, "run-pr-review");
  assert.deepEqual(body.client_payload, {
    schema_version: "1",
    request_id: "review-9-1",
    repository: "fongap/example",
    pr_number: 42,
    head_sha: headSha,
  });
  validatePayload(body.client_payload);
});

test("AI review dispatch rejects malformed identity before any GitHub call", () => {
  assert.throws(
    () => buildReviewDispatch("bad repository", "42", "review-1", headSha),
    /repository/
  );
  assert.throws(() => buildReviewDispatch("fongap/example", "0", "review-1", headSha), /PR number/);
  assert.throws(
    () => buildReviewDispatch("fongap/example", "4x", "review-1", headSha),
    /PR number/
  );
  assert.throws(() => buildReviewDispatch("fongap/example", "42", "bad id", headSha), /request id/);
  assert.throws(() => buildReviewDispatch("fongap/example", "42", "review-1", "abc"), /head SHA/);
});

test("PR review comment says AI review is queued only while it is pending", () => {
  const queued = buildReview("success", "https://example.test/run", undefined, undefined, true);
  assert.match(queued, /Gate: \*\*PASS\*\*/);
  assert.match(queued, /AI Review: queued/);
  assert.doesNotMatch(queued, /policy skipped|unavailable or incomplete/);

  const skipped = buildReview("success", "https://example.test/run", undefined, undefined);
  assert.match(skipped, /AI Review: policy skipped\./);

  const finished = buildReview(
    "success",
    "https://example.test/run",
    { review_required: true, review_agent: "code" },
    { comments: [] },
    true
  );
  assert.match(finished, /AI Review found no issues\./);
  assert.doesNotMatch(finished, /queued/);
});
