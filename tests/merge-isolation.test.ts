import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
};

type WorkflowJob = {
  needs?: string;
  if?: string;
  outputs?: Record<string, string>;
  "continue-on-error"?: boolean;
  steps: WorkflowStep[];
};

test("main-write gate completion never depends on automatic merge execution", () => {
  const path = ".github/workflows/handle-pr-dispatch.yml";
  const workflow = parse(readFileSync(path, "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const govern = workflow.jobs.govern;
  const merge = workflow.jobs["auto-merge"];
  const recovery = workflow.jobs["resolve-unfinished"];
  assert.ok(govern && merge && recovery);

  const gateNames = govern.steps.map((step) => step.name);
  const finalIndex = gateNames.indexOf("Update final gate");
  const mergeGateIndex = gateNames.indexOf("Update central merge gate");
  assert.ok(finalIndex >= 0 && mergeGateIndex > finalIndex);
  assert.equal(
    govern.steps.some(
      (step) =>
        step.name === "Automatically merge CI-green PR" ||
        step.name === "Mint automatic merge token" ||
        step.run?.includes("scripts/auto-merge-pr.ts")
    ),
    false,
    "the signed approval job cannot execute the merge side effect"
  );

  assert.equal(merge.needs, "govern");
  assert.equal(merge["continue-on-error"], true);
  assert.match(merge.if ?? "", /needs\.govern\.result == 'success'/);
  assert.match(merge.if ?? "", /needs\.govern\.outputs\.approved == 'true'/);
  assert.match(govern.outputs?.approved ?? "", /steps\.gate\.outputs\.passed == 'true'/);
  assert.match(govern.outputs?.approved ?? "", /steps\.ownership\.outputs\.current == 'true'/);
  assert.match(govern.outputs?.approved ?? "", /steps\.cancellation\.outputs\.cancelled != 'true'/);

  const mergeRun = merge.steps.find((step) => step.name === "Automatically merge CI-green PR");
  assert.ok(mergeRun);
  assert.match(mergeRun.run ?? "", /scripts\/auto-merge-pr\.ts/);
  assert.match(mergeRun.env?.RUN_URL ?? "", /github\.run_id/);
  assert.match(mergeRun.env?.AW_STATUS_KEYRING ?? "", /AW_STATUS_KEYRING/);
  assert.match(mergeRun.env?.HEAD_SHA ?? "", /steps\.facts\.outputs\.head_sha/);
  const facts = merge.steps.find((step) => step.name === "Fetch exact pull request identity");
  assert.equal(facts?.env?.ALLOW_MERGED_PR, "true");

  assert.equal(recovery.needs, "govern");
  assert.match(recovery.if ?? "", /needs\.govern\.result != 'success'/);
  const reviewToken = govern.steps.find(
    (step) => step.id === "issue_app" && step.name === "Publish PR review"
  );
  assert.equal(reviewToken?.["continue-on-error"], true);
});

test("operational merge failure cannot be mistaken for an ignored CI failure", () => {
  const workflow = parse(readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const govern = workflow.jobs.govern;
  const merge = workflow.jobs["auto-merge"];
  assert.ok(govern && merge);
  const requiredGates = ["Update final gate", "Update central merge gate"];
  for (const name of requiredGates) {
    const step: WorkflowStep | undefined = govern.steps.find((item) => item.name === name);
    assert.ok(step);
    assert.notEqual(step["continue-on-error"], true, `${name} must remain fail-closed`);
  }
  assert.equal(
    merge.steps.filter((step) => step.name === "Automatically merge CI-green PR").length,
    1,
    "exactly one nonblocking merge executor is allowed"
  );
});
