import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type Job = {
  if?: string;
  strategy?: { matrix?: { shard?: string } };
  steps: Step[];
};
type Workflow = { jobs: Record<string, Job>; permissions: Record<string, string> };

test("source-owned CI runs only in the private caller with no central secret", async () => {
  const source = await readFile(".github/workflows/private-source-ci.yml", "utf8");
  const workflow = parse(source) as Workflow;
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(source, /secrets\.|secrets:|pull_request_target|workflow_dispatch/);
  assert.match(source, /IS_PRIVATE.*github\.event\.repository\.private/);
  assert.match(source, /SOURCE.*github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(source, /EVENT_BASE|EVENT_HEAD/);
});

test("every Linux shard and Windows use trusted base controls and exact PR merge SHA", async () => {
  const workflow = parse(
    await readFile(".github/workflows/private-source-ci.yml", "utf8")
  ) as Workflow;
  assert.equal(
    workflow.jobs.linux.strategy?.matrix?.shard,
    "${{ fromJSON(needs.prepare.outputs.linux_shards) }}"
  );
  assert.match(workflow.jobs.windows.if ?? "", /has_windows == 'true'/);
  for (const id of ["linux", "windows"]) {
    const job = workflow.jobs[id];
    assert.ok(job, id);
    const steps = job.steps;
    const merge = steps.find((x) => x.name === "Checkout private PR merge snapshot");
    const controls = steps.find((x) => x.name === "Checkout trusted private CI controls");
    const pack = steps.find((x) => x.name === "Checkout pinned public test pack");
    assert.equal(merge?.with?.ref, "${{ github.sha }}");
    assert.equal(controls?.with?.ref, "${{ inputs.base_sha }}");
    assert.equal(pack?.with?.ref, "${{ inputs.action_worker_sha }}");
    for (const step of [merge, controls, pack]) {
      assert.equal(step?.with?.["persist-credentials"], false);
    }
    assert.ok(steps.some((step) => /trusted private (Linux|Windows) CI/.test(step.name ?? "")));
    assert.match(JSON.stringify(steps), /CENTRAL_CI_BASE_SHA/);
    assert.match(JSON.stringify(steps), /CENTRAL_CI_HEAD_SHA/);
  }
});

test("private CI plan is not a forged public control-plane verdict", async () => {
  const [source, plan] = await Promise.all([
    readFile(".github/workflows/private-source-ci.yml", "utf8"),
    readFile("scripts/private-ci-plan.ts", "utf8"),
  ]);
  assert.match(source, /node aw\/scripts\/private-ci-plan\.ts/);
  assert.match(plan, /resolveLinuxShards/);
  assert.match(plan, /declaresWindows !== hasWindowsScript/);
  assert.doesNotMatch(source, /CI Evidence|write-commit-status|continue-on-error/);
});
