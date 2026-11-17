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
  assert.doesNotMatch(source, /secrets\.|secrets:|workflow_dispatch/);
  assert.match(source, /IS_PRIVATE.*github\.event\.repository\.private/);
  assert.match(source, /SOURCE.*github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(source, /EVENT_BASE|EVENT_HEAD/);
  assert.ok(source.includes('"$EVENT" == "pull_request_target"'));
  assert.doesNotMatch(source, /github\.sha/);
});

test("every Linux shard and Windows use trusted base controls and exact PR merge SHA", async () => {
  const workflow = parse(
    await readFile(".github/workflows/private-source-ci.yml", "utf8")
  ) as Workflow;
  const linux = workflow.jobs.linux;
  const windows = workflow.jobs.windows;
  assert.ok(linux);
  assert.ok(windows);
  assert.equal(
    linux.strategy?.matrix?.shard,
    "${{ fromJSON(needs.prepare.outputs.linux_shards) }}"
  );
  assert.match(windows.if ?? "", /has_windows == 'true'/);
  for (const id of ["linux", "windows"]) {
    const job = workflow.jobs[id];
    assert.ok(job, id);
    const steps = job.steps;
    const merge = steps.find((x) => x.name === "Checkout private PR merge snapshot");
    const controls = steps.find((x) => x.name === "Checkout trusted private CI controls");
    const pack = steps.find((x) => x.name === "Checkout pinned public test pack");
    assert.equal(merge?.with?.ref, "${{ needs.prepare.outputs.merge_sha }}");
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

test("private caller pins PR merge parents and executes mandatory private security", async () => {
  const source = await readFile(".github/workflows/private-source-ci.yml", "utf8");
  const workflow = parse(source) as Workflow;
  const prep = workflow.jobs.prepare;
  const security = workflow.jobs.security;
  assert.ok(prep?.steps.some((step) => step.name === "Pin and verify PR merge parents"));
  assert.match(source, /refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge/);
  assert.match(source, /actual_base.*BASE_SHA/);
  assert.match(source, /actual_head.*HEAD_SHA/);
  assert.ok(security);
  assert.ok(
    security.steps.some((step) => step.name === "Validate source security and dependency locks")
  );
  assert.match(JSON.stringify(security.steps), /validate-security\.ts/);
  assert.match(JSON.stringify(security.steps), /dependency-lock-integrity\.ts/);
  assert.doesNotMatch(source, /persist-credentials: true|secrets\./);
});

test("pinned private caller is read-only and matches audited workflow hash", async () => {
  const { createHash } = await import("node:crypto");
  const caller = await readFile("templates/bridge/private-source-ci.yml", "utf8");
  const policy = JSON.parse(await readFile("policies/security.json", "utf8")) as {
    approved_workflows: { path: string; sha256: string }[];
  };
  const entry = policy.approved_workflows.find(
    (item) => item.path === ".github/workflows/private-source-ci.yml"
  );
  assert.ok(entry);
  assert.equal(
    createHash("sha256").update(caller.replace(/\r\n/g, "\n")).digest("hex"),
    entry.sha256
  );
  assert.match(caller, /pull_request_target/);
  assert.match(caller, /permissions:\n  contents: read/);
  assert.match(caller, /private-source-ci\.yml@[0-9a-f]{40}/);
  assert.doesNotMatch(caller, /secrets:|secrets\.|workflow_dispatch|pull_request:|write-all/);
});
