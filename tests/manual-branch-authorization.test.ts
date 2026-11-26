import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

test("branch authorization reuses admin-ops and never signs an unchecked request", () => {
  const source = readFileSync(".github/workflows/authorize-branch-transfer.yml", "utf8");
  const workflow = parse(source) as {
    on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } };
    jobs: Record<
      string,
      {
        environment: unknown;
        steps: Array<{ name: string; if?: string; run?: string; env?: Record<string, string> }>;
      }
    >;
  };
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.confirm, {
    description: "确认授权本次指定仓库和提交（不勾选仅检查）",
    type: "boolean",
    required: true,
    default: false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["authorize"]);
  const job = workflow.jobs.authorize!;
  assert.deepEqual(job.environment, { name: "admin-ops", deployment: false });
  const steps = job.steps;
  const plan = steps.find((step) => step.run?.endsWith(" plan"));
  const verify = steps.find((step) => step.run?.endsWith(" verify"));
  const approve = steps.find((step) => step.run?.endsWith(" approve"));
  const mint = steps.find((step) => step.name === "Mint initialization receipt token");
  assert.ok(plan && verify && approve && mint);
  assert.equal(plan.if, undefined);
  assert.equal(verify.if, "inputs.confirm");
  assert.equal(approve.if, "inputs.confirm");
  assert.equal(mint.if, "inputs.confirm && inputs.operation == 'initialize-dev'");
  assert.ok(steps.indexOf(plan) < steps.indexOf(verify));
  assert.ok(steps.indexOf(verify) < steps.indexOf(mint));
  assert.ok(steps.indexOf(mint) < steps.indexOf(approve));
  for (const step of [plan, verify, approve]) {
    assert.equal(step.env?.OPERATOR_CONFIRMED, "${{ inputs.confirm }}");
    assert.equal(step.env?.TRANSFER_SNAPSHOT, "${{ inputs.transfer_snapshot }}");
  }
  assert.doesNotMatch(source, /name: branch-transfer|permission-contents: write/);
});
