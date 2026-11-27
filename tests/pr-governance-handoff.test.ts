import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

function workflow(path: string) {
  return parse(readFileSync(path, "utf8")) as {
    jobs: Record<
      string,
      { if?: string; steps: Array<{ name?: string; if?: string; id?: string; run?: string }> }
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
  assert.match(resume.run ?? "", /target_branch:\$target_branch/);
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
  assert.match(resume.run ?? "", /\.head\.sha == \$head/);
  assert.match(resume.run ?? "", /\.base\.ref == \$branch/);
  assert.match(resume.run ?? "", /target_branch:\$target_branch/);
  assert.ok(steps.indexOf(publish) < steps.indexOf(resume));
  const failureSteps = workflow(".github/workflows/central-ci-dispatch.yml").jobs[
    "prepare-failure"
  ]!.steps;
  const failed = step(failureSteps, "Publish failed CI Evidence for the current head");
  const recover = step(failureSteps, "Resume PR governance after CI prepare failure");
  assert.match(failed.run ?? "", /echo "published=true"/);
  assert.match(recover.if ?? "", /steps\.prepare_publish\.outputs\.published == 'true'/);
  assert.match(recover.run ?? "", /run-pr-governance/);
  assert.match(recover.run ?? "", /target_branch:\$target_branch/);
  assert.ok(failureSteps.indexOf(failed) < failureSteps.indexOf(recover));
});

test("development governance validates but cannot invoke main merge or refresh", () => {
  const content = readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const steps = workflow(".github/workflows/handle-pr-dispatch.yml").jobs.govern!.steps;
  assert.match(content, /approved:.*target_branch == 'main'/);
  assert.match(
    step(steps, "Refresh behind branch before expensive CI").if ?? "",
    /target_branch == 'main'/
  );
  assert.match(
    step(steps, "Verify current dev governance scope").run ?? "",
    /verify-dev-governance/
  );
});

test("dev merge admission has read-only credentials and is never the automatic merge job", () => {
  const content = readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const steps = workflow(".github/workflows/handle-pr-dispatch.yml").jobs.govern!.steps;
  const check = step(steps, "Verify dev merge admission without write access");
  assert.match(check.if ?? "", /target_branch == 'dev'/);
  assert.equal(check.run, "node scripts/dev-merge-admission.ts");
  assert.match(content, /approved:.*target_branch == 'main'/);
  assert.equal(content.split("AW_DEV_GOVERNANCE_RECEIPT:").length - 1, 2);
});

test("dev write credential follows the reviewed protection boundary", () => {
  const steps = workflow(".github/workflows/handle-pr-dispatch.yml").jobs["dev-merge"]!.steps;
  const authorize = step(steps, "Verify protected dev execution boundary");
  const mint = step(steps, "Mint automatic merge token");
  const execute = step(steps, "Execute admitted development merge");
  assert.match(authorize.run ?? "", /dev-merge-execution\.ts authorize/);
  assert.match(mint.if ?? "", /steps\.dev_execution\.outputs\.enabled == 'true'/);
  assert.equal(execute.if, "steps.dev_execution.outputs.enabled == 'true'");
  assert.ok(steps.indexOf(authorize) < steps.indexOf(mint));
  assert.ok(steps.indexOf(mint) < steps.indexOf(execute));
  const audit = workflow(".github/workflows/intake.yml").jobs["dev-writes"]!.steps;
  assert.equal(step(audit, "Audit managed dev branches").run, "node scripts/audit-dev-writes.ts");
});

test("dev merge reads the already validated immutable event head instead of masked job output", () => {
  const content = readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8");
  assert.doesNotMatch(content, /needs\.govern\.outputs\.dev_head/);
  assert.doesNotMatch(content, /\bdev_head:/);
  const merge = content.slice(content.indexOf("  dev-merge:"));
  assert.equal(merge.split("HEAD_SHA: ${{ github.event.client_payload.head_sha }}").length - 1, 2);
  assert.match(content, /run: test "\$REQUESTED_HEAD" = "\$RESOLVED_HEAD"/);
});

test("both merge jobs explicitly handle a skipped legacy ancestor without bypassing governance", () => {
  const jobs = workflow(".github/workflows/handle-pr-dispatch.yml").jobs;
  for (const name of ["auto-merge", "dev-merge"]) {
    assert.match(jobs[name]?.if ?? "", /!cancelled\(\)/);
    assert.match(jobs[name]?.if ?? "", /needs\.govern\.result == 'success'/);
  }
  assert.match(jobs["dev-merge"]?.if ?? "", /needs\.govern\.outputs\.dev_approved == 'true'/);
  const content = readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8");
  assert.doesNotMatch(content, /needs\.govern\.outputs\.dev_base|\bdev_base:/);
  const steps = jobs["dev-merge"]!.steps;
  const facts = step(steps, "Fetch current development PR identity");
  assert.equal(facts.run, "node scripts/resolve-pr-facts.ts fetch");
  assert.ok(
    steps.indexOf(facts) < steps.indexOf(step(steps, "Verify protected dev execution boundary"))
  );
});
