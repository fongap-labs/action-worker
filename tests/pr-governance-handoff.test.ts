import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

function workflow(path: string) {
  return parse(readFileSync(path, "utf8")) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; if?: string; id?: string; run?: string }> }
    >;
  };
}

function step(
  steps: Array<{ name?: string; if?: string; id?: string; run?: string }>,
  name: string
) {
  const match = steps.find((item) => item.name === name);
  assert.ok(match, "Missing " + name);
  return match;
}

test("PR governance releases its runner while CI is signed pending, never approves a deferred gate", () => {
  const steps = workflow(".github/workflows/handle-pr-dispatch.yml").jobs.govern!.steps;
  const dispatch = steps.find((item) => item.id === "ci_dispatch");
  assert.ok(dispatch);
  assert.equal(dispatch.name, "Dispatch centralized CI");
  for (const name of [
    "Collect CI evidence",
    "Validate CI evidence",
    "Mark deterministic gate passed",
    "Mint final governance read token",
    "Resolve governance ownership",
  ]) {
    assert.match(step(steps, name).if ?? "", /steps\.ci_dispatch\.outputs\.deferred != 'true'/);
  }
  const dispatcher = readFileSync("scripts/dispatch-central-ci.ts", "utf8");
  assert.match(dispatcher, /hasVerifiedCiEvidence/);
  assert.match(dispatcher, /hasActiveCiEvidenceReservation/);
  assert.match(dispatcher, /hasUnresolvedCiEvidenceFailure/);
  assert.match(dispatcher, /await appendLines\(process\.env\.GITHUB_OUTPUT, \["deferred=true"\]\)/);
  assert.match(step(steps, "Validate CI evidence").run ?? "", /validate-ci-evidence\.ts/);
  const merge = workflow(".github/workflows/handle-pr-dispatch.yml").jobs["auto-merge"];
  assert.ok(merge);
  assert.match(
    readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8"),
    /needs\.govern\.outputs\.approved == 'true'/
  );
});

test("long-running central PR CI takes over the signed lease and preserves required jobs", () => {
  const content = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
  const steps = workflow(".github/workflows/central-ci-dispatch.yml").jobs.prepare!.steps;
  const lease = step(steps, "Attach PR CI lease to active Central CI run");
  assert.match(lease.if ?? "", /github\.event\.action == 'run-central-ci'/);
  assert.match(lease.run ?? "", /write-commit-status\.ts/);
  assert.match(lease.run ?? "", /"CI Evidence"/);
  assert.match(content, /name: Attach Main CI lease to active Central CI run/);
  for (const job of ["linux", "windows", "security", "finalize"])
    assert.ok(content.includes(`  ${job}:`));
  assert.match(content, /needs\.prepare\.outputs\.should_run != 'false'/);
});

test("CI success resumes PR governance only after signed source and completed run verification", () => {
  const steps = workflow(".github/workflows/ci-follow-up.yml").jobs["follow-up"]!.steps;
  const verified = step(steps, "Verify completed CI evidence and source revision");
  const resume = step(steps, "Resume PR governance after verified CI");
  assert.match(verified.run ?? "", /verify-ci-follow-up\.ts/);
  assert.match(resume.if ?? "", /steps\.verified\.outputs\.current == 'true'/);
  assert.match(resume.if ?? "", /pr_number > 0/);
  assert.match(resume.run ?? "", /run-pr-governance/);
  assert.match(resume.run ?? "", /--arg request_id "ci-done-\$CI_RUN_ID"/);
  assert.ok(steps.indexOf(verified) < steps.indexOf(resume));
});

test("CI failure and prepare failure reopen a red gate only after status publication", () => {
  const steps = workflow(".github/workflows/central-ci-dispatch.yml").jobs.finalize!.steps;
  const publish = step(steps, "Publish target status");
  const resume = step(steps, "Resume PR governance after failed CI");
  assert.match(publish.run ?? "", /echo "published=true"/);
  assert.match(resume.if ?? "", /steps\.ci_publish\.outputs\.published == 'true'/);
  assert.match(resume.if ?? "", /steps\.ci_publish\.outcome == 'failure'/);
  assert.match(resume.run ?? "", /run-pr-governance/);
  assert.match(resume.run ?? "", /current_head/);
  assert.match(resume.run ?? "", /\$current_head" == "\$TARGET_HEAD_SHA/);
  assert.ok(steps.indexOf(publish) < steps.indexOf(resume));
  const failureSteps = workflow(".github/workflows/central-ci-dispatch.yml").jobs[
    "prepare-failure"
  ]!.steps;
  const failed = step(failureSteps, "Publish failed CI Evidence for the current head");
  const recover = step(failureSteps, "Resume PR governance after CI prepare failure");
  assert.match(failed.run ?? "", /echo "published=true"/);
  assert.match(recover.if ?? "", /steps\.prepare_publish\.outputs\.published == 'true'/);
  assert.match(recover.run ?? "", /run-pr-governance/);
  assert.ok(failureSteps.indexOf(failed) < failureSteps.indexOf(recover));
});
