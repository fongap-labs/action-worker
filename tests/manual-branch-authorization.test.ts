import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { resolveBranchSourceSha } from "../scripts/authorize-branch-operation.ts";

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
    description: "确认授权本次锁定的目标及提交（不勾选仅检查）",
    type: "boolean",
    required: true,
    default: false,
  });
  assert.equal(workflow.on.workflow_dispatch.inputs.source_sha?.required, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.transfer_snapshot?.required, false);
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
  assert.equal(
    mint.if,
    "inputs.confirm && (inputs.operation == 'initialize-dev' || inputs.operation == 'adopt-dev')"
  );
  assert.ok(steps.indexOf(plan) < steps.indexOf(verify));
  assert.ok(steps.indexOf(verify) < steps.indexOf(mint));
  assert.ok(steps.indexOf(mint) < steps.indexOf(approve));
  for (const step of [plan, verify, approve]) {
    assert.equal(step.env?.OPERATOR_CONFIRMED, "${{ inputs.confirm }}");
    assert.equal(
      step.env?.REPOSITORY,
      "${{ contains(inputs.repository, '/') && inputs.repository || format('{0}/{1}', github.repository_owner, inputs.repository) }}"
    );
  }
  assert.equal(plan.env?.SOURCE_SHA, "${{ inputs.source_sha }}");
  assert.equal(plan.env?.TRANSFER_SNAPSHOT, "${{ inputs.transfer_snapshot }}");
  for (const step of [verify, approve]) {
    assert.equal(step.env?.SOURCE_SHA, "${{ steps.plan.outputs.source_sha }}");
    assert.equal(step.env?.TRANSFER_SNAPSHOT, "${{ steps.plan.outputs.transfer_snapshot }}");
  }
  const ref = steps.find((step) => step.name === "Mint repository-scoped initialization ref token");
  assert.ok(ref);
  assert.equal(ref.if, "inputs.confirm && inputs.operation == 'initialize-dev'");
  assert.ok(steps.indexOf(verify) < steps.indexOf(ref));
  assert.ok(steps.indexOf(ref) < steps.indexOf(approve));
  assert.equal(approve.env?.AW_DEV_REF_TOKEN, "${{ steps.ref_app.outputs.token }}");
  assert.doesNotMatch(source, /name: branch-transfer/);
  assert.equal(source.match(/permission-contents: write/g)?.length, 1);
});

test("source SHA is automatically resolved from main or PR HEAD when omitted", async () => {
  const repository = "org/product";
  const mainSha = "a".repeat(40);
  const prSha = "b".repeat(40);
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/branches/main`) return { commit: { sha: mainSha } };
      if (path === `repos/${repository}/pulls/12`) return { head: { sha: prSha } };
      assert.fail(path);
    },
  };
  assert.equal(await resolveBranchSourceSha(reader, "initialize-dev", repository, 0, ""), mainSha);
  assert.equal(await resolveBranchSourceSha(reader, "transfer", repository, 12, " "), prSha);
});

test("manual source override takes precedence and invalid inputs fail closed", async () => {
  const repository = "org/product";
  const sha = "c".repeat(40);
  const reader = {
    async get(): Promise<unknown> {
      assert.fail("manual override must not silently fall back to auto discovery");
    },
  };
  assert.equal(await resolveBranchSourceSha(reader, "initialize-dev", repository, 0, sha), sha);
  assert.equal(await resolveBranchSourceSha(reader, "transfer", repository, 12, sha), sha);
  await assert.rejects(
    resolveBranchSourceSha(reader, "transfer", repository, 12, "bad"),
    /40-character/
  );
  await assert.rejects(
    resolveBranchSourceSha(reader, "transfer", repository, 0, sha),
    /Invalid branch/
  );
  await assert.rejects(
    resolveBranchSourceSha(reader, "initialize-dev", repository, 1, sha),
    /Invalid branch/
  );
});

test("missing automatic SHA is rejected rather than inventing a fallback", async () => {
  const reader = {
    async get(): Promise<unknown> {
      return {};
    },
  };
  await assert.rejects(
    resolveBranchSourceSha(reader, "initialize-dev", "org/product", 0, ""),
    /unavailable/
  );
});
