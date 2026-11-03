import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import {
  isCurrentFollowUpTarget,
  matchesFollowUpEvidence,
  parseFollowUpRequest,
} from "../scripts/verify-ci-follow-up.ts";

const repository = "fongap-labs/dsh-plugin";
const sha = "a".repeat(40);
const controlRepository = "fongap-labs/action-worker";
const runId = 41461735628;
const request = { repository, head_sha: sha, pr_number: 40, ci_run_id: runId };

test("CI follow-ups require a complete revision-bound dispatch payload", () => {
  assert.deepEqual(parseFollowUpRequest(request), request);
  assert.deepEqual(parseFollowUpRequest({ ...request, pr_number: 0 }), {
    ...request,
    pr_number: 0,
  });
  for (const invalid of [
    { ...request, head_sha: "short" },
    { ...request, ci_run_id: 0 },
    { ...request, pr_number: -1 },
    { ...request, repository: "other" },
    { ...request, unexpected: "value" },
  ]) {
    assert.throws(() => parseFollowUpRequest(invalid));
  }
});

test("CI follow-ups cannot borrow another run's CI Evidence", () => {
  const status = {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        target_url: `https://github.com/${controlRepository}/actions/runs/${runId}`,
      },
    ],
  };
  assert.equal(matchesFollowUpEvidence(status, controlRepository, runId), true);
  assert.equal(matchesFollowUpEvidence(status, controlRepository, runId + 1), false);
  assert.equal(
    matchesFollowUpEvidence(
      { statuses: [{ ...status.statuses[0], state: "pending" }] },
      controlRepository,
      runId
    ),
    false
  );
  assert.equal(
    matchesFollowUpEvidence(
      {
        statuses: [
          {
            ...status.statuses[0],
            target_url: "https://github.com/other/repo/actions/runs/41461735628",
          },
        ],
      },
      controlRepository,
      runId
    ),
    false
  );
});

test("CI completion dispatches follow-ups independently of its merge verdict", async () => {
  const main = parse(await readFile(".github/workflows/central-ci-dispatch.yml", "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const next = parse(await readFile(".github/workflows/ci-follow-up.yml", "utf8")) as {
    on: { repository_dispatch: { types: string[] } };
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  assert.equal(main.jobs["follow-up"], undefined);
  assert.match(JSON.stringify(main.jobs.finalize), /run-ci-follow-up/);
  assert.deepEqual(next.on.repository_dispatch.types, ["run-ci-follow-up"]);
  assert.match(JSON.stringify(next.jobs["follow-up"]), /verify-ci-follow-up.ts/);
  assert.match(JSON.stringify(next.jobs["follow-up"]), /dispatch-security-scan.ts/);
  assert.match(JSON.stringify(next.jobs["follow-up"]), /audit-main-writes.ts/);
  assert.match(JSON.stringify(next.jobs["follow-up"]), /dispatch-central-deploy.ts/);
});

test("superseded main commits and stale PRs are not current follow-up targets", () => {
  const mainRequest = { ...request, pr_number: 0 };
  assert.equal(isCurrentFollowUpTarget(mainRequest, { sha }), true);
  assert.equal(isCurrentFollowUpTarget(mainRequest, { sha: "b".repeat(40) }), false);
  assert.equal(isCurrentFollowUpTarget(mainRequest, {}), false);
  assert.equal(isCurrentFollowUpTarget(request, { state: "open", head: { sha } }), true);
  assert.equal(isCurrentFollowUpTarget(request, { state: "closed", head: { sha } }), false);
  assert.equal(
    isCurrentFollowUpTarget(request, { state: "open", head: { sha: "b".repeat(40) } }),
    false
  );
});

test("only current CI follow-ups can dispatch scans, audit main or deploy", async () => {
  const next = parse(await readFile(".github/workflows/ci-follow-up.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; if?: string }> }>;
  };
  const steps = next.jobs["follow-up"]!.steps;
  for (const name of [
    "Dispatch central security scan",
    "Attest deploy source main write",
    "Dispatch automatic deploy",
  ]) {
    const step = steps.find((item) => item.name === name);
    assert.ok(step, `Missing ${name} step`);
    assert.match(step.if ?? "", /steps\.verified\.outputs\.current == 'true'/);
  }
});
