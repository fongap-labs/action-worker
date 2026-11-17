import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  with?: Record<string, string | boolean>;
};
type Job = {
  if?: string;
  needs?: string[];
  strategy?: { matrix?: { shard?: string } };
  steps: Step[];
};
type Workflow = {
  jobs: Record<string, Job>;
  permissions: Record<string, string>;
};

const path = ".github/workflows/private-ref-ci.yml";

test("private main CI accepts only a protected, immutable private push", async () => {
  const source = await readFile(path, "utf8");
  const workflow = parse(source) as Workflow;
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(source, /secrets\.|write-commit-status|CI Evidence|continue-on-error/);
  assert.doesNotMatch(source, /pull_request_target|workflow_dispatch|repository_dispatch/);
  const prepare = workflow.jobs.prepare;
  assert.ok(prepare);
  const serialized = source;
  for (const marker of [
    '"$EVENT" == "push"',
    '"$REF" == "refs/heads/main"',
    '"$IS_PRIVATE" == "true"',
    '"$HEAD_SHA" == "$EVENT_SHA"',
    '"$HEAD_SHA" == "$EVENT_AFTER"',
    '"$BASE_SHA" == "$EVENT_BEFORE"',
    "git -C control show -s --format=%P HEAD",
  ]) {
    assert.ok(serialized.includes(marker), marker);
  }
  assert.match(serialized, /node aw\/scripts\/private-ci-plan\.ts/);
});

test("private main Linux and Windows run pinned source code on caller runners", async () => {
  const workflow = parse(await readFile(path, "utf8")) as Workflow;
  const linux = workflow.jobs.linux;
  const windows = workflow.jobs.windows;
  assert.ok(linux);
  assert.ok(windows);
  assert.equal(
    linux.strategy?.matrix?.shard,
    "${{ fromJSON(needs.prepare.outputs.linux_shards) }}"
  );
  assert.match(windows.if ?? "", /has_windows == 'true'/);
  for (const name of ["linux", "windows"]) {
    const steps = workflow.jobs[name]?.steps ?? [];
    const checkout = steps.find((s) => s.name === "Checkout exact private main commit");
    const pack = steps.find((s) => s.name === "Checkout pinned public test pack");
    assert.equal(checkout?.with?.ref, "${{ inputs.ref_sha }}");
    assert.equal(pack?.with?.ref, "${{ inputs.action_worker_sha }}");
    assert.equal(pack?.with?.repository, "fongap-labs/action-worker");
    assert.equal(checkout?.with?.["persist-credentials"], false);
    assert.equal(pack?.with?.["persist-credentials"], false);
    assert.match(JSON.stringify(steps), /\.github\/scripts\/central-ci\.(?:sh|ps1)/);
  }
});

test("private main security and complete result remain fail-closed", async () => {
  const source = await readFile(path, "utf8");
  const workflow = parse(source) as Workflow;
  const security = workflow.jobs.security;
  const verify = workflow.jobs.verify;
  assert.ok(security);
  assert.ok(verify);
  assert.deepEqual(verify.needs, ["prepare", "linux", "security", "windows"]);
  assert.equal(verify.if, "always()");
  assert.match(JSON.stringify(security.steps), /validate-security\.ts/);
  assert.match(JSON.stringify(security.steps), /dependency-lock-integrity\.ts/);
  const policy = security.steps.find(
    (s) => s.name === "Checkout protected current security policy"
  );
  assert.equal(policy?.with?.repository, "fongap-labs/action-worker");
  assert.equal(policy?.with?.ref, "main");
  assert.equal(policy?.with?.["persist-credentials"], false);
  const run = verify.steps.find((s) => s.name === "Require complete private source execution")?.run;
  assert.ok(run);
  assert.match(run, /"\$PREPARE" == "success"/);
  assert.match(run, /"\$LINUX" == "success"/);
  assert.match(run, /"\$SECURITY" == "success"/);
  assert.match(run, /"\$WINDOWS" == "success"/);
  assert.match(run, /"\$WINDOWS" == "skipped"/);
});
