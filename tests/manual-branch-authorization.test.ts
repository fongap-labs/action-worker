import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  resolveBranchSourceSha,
  resolveTransferPrNumber,
} from "../scripts/authorize-branch-operation.ts";

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
  assert.deepEqual(Object.keys(workflow.jobs), [
    "authorize",
    "transfer-governance",
    "transfer-linux",
    "transfer-windows",
    "transfer-execute",
  ]);
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
  assert.equal(plan.env?.PR_NUMBER, "${{ inputs.pr_number }}");
  assert.equal(workflow.on.workflow_dispatch.inputs.pr_number?.default, 0);
  assert.equal(plan.env?.TRANSFER_SNAPSHOT, "${{ inputs.transfer_snapshot }}");
  for (const step of [verify, approve]) {
    assert.equal(step.env?.SOURCE_SHA, "${{ steps.plan.outputs.source_sha }}");
    assert.equal(step.env?.PR_NUMBER, "${{ steps.plan.outputs.pr_number }}");
    assert.equal(step.env?.TRANSFER_SNAPSHOT, "${{ steps.plan.outputs.transfer_snapshot }}");
  }
  const ref = steps.find((step) => step.name === "Mint repository-scoped initialization ref token");
  assert.ok(ref);
  assert.equal(ref.if, "inputs.confirm && inputs.operation == 'initialize-dev'");
  assert.ok(steps.indexOf(verify) < steps.indexOf(ref));
  assert.ok(steps.indexOf(ref) < steps.indexOf(approve));
  assert.equal(approve.env?.AW_DEV_REF_TOKEN, "${{ steps.ref_app.outputs.token }}");
  assert.doesNotMatch(source, /name: branch-transfer/);
  assert.equal(source.match(/permission-contents: write/g)?.length, 2);
  assert.equal(source.match(/permission-pull-requests: write/g)?.length, 1);
  assert.ok(source.includes("needs.transfer-governance.result == 'success'"));
  assert.ok(source.includes("needs.transfer-linux.result == 'success'"));
  assert.ok(source.includes("scripts/branch-transfer-execution.ts execute"));
  assert.ok(source.includes("scripts/branch-transfer-execution.ts cleanup"));
  assert.ok(source.includes("TRANSFER_MERGE_SHA:"));
  assert.ok(source.includes("if: always() && steps.transfer_status.outputs.token != ''"));
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

function transferFixture() {
  const repository = "org/product";
  const repo = { full_name: repository };
  const forward = {
    number: 103,
    state: "open",
    draft: false,
    head: { ref: "dev", repo },
    base: { ref: "main", repo },
  };
  const reverse = {
    ...forward,
    number: 104,
    head: { ref: "main", repo },
    base: { ref: "dev", repo },
  };
  const closed = { ...forward, number: 102, state: "closed" };
  const ordinary = { ...forward, number: 101, head: { ref: "fix/dependency", repo } };
  const fork = {
    ...forward,
    number: 105,
    head: { ref: "dev", repo: { full_name: "other/product" } },
  };
  const draft = { ...forward, number: 106, draft: true };
  const entries = new Map<string, unknown>([
    [`repos/${repository}/pulls?state=open&head=org%3Adev&base=main&per_page=100`, [forward]],
    [`repos/${repository}/pulls?state=open&head=org%3Amain&base=dev&per_page=100`, []],
    [`repos/${repository}/pulls/103`, forward],
    [`repos/${repository}/pulls/102`, closed],
    [`repos/${repository}/pulls/101`, ordinary],
    [`repos/${repository}/pulls/105`, fork],
    [`repos/${repository}/pulls/106`, draft],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(entries.has(path), path);
      return entries.get(path);
    },
  };
  return { repository, reader, entries, forward, reverse, closed, ordinary, fork, draft };
}

test("zero discovers the sole open same-repository transfer; explicit number remains exact", async () => {
  const world = transferFixture();
  assert.equal(await resolveTransferPrNumber(world.reader, world.repository, 0), 103);
  assert.equal(await resolveTransferPrNumber(world.reader, world.repository, 103), 103);
  for (const number of [102, 101, 105, 106]) {
    await assert.rejects(
      resolveTransferPrNumber(world.reader, world.repository, number),
      /not an open, non-draft same-repository/
    );
  }
});

test("automatic discovery rejects absent, ambiguous and incomplete transfers", async () => {
  const world = transferFixture();
  const forwardPath = `repos/${world.repository}/pulls?state=open&head=org%3Adev&base=main&per_page=100`;
  const reversePath = `repos/${world.repository}/pulls?state=open&head=org%3Amain&base=dev&per_page=100`;
  world.entries.set(forwardPath, [world.closed, world.ordinary, world.fork, world.draft]);
  await assert.rejects(
    resolveTransferPrNumber(world.reader, world.repository, 0),
    /No open main\/dev transfer PR/
  );
  world.entries.set(reversePath, [world.reverse]);
  assert.equal(await resolveTransferPrNumber(world.reader, world.repository, 0), 104);
  world.entries.set(forwardPath, [world.forward]);
  await assert.rejects(
    resolveTransferPrNumber(world.reader, world.repository, 0),
    /Multiple cross-branch PRs/
  );
  world.entries.set(forwardPath, Array(100).fill(world.forward));
  await assert.rejects(
    resolveTransferPrNumber(world.reader, world.repository, 0),
    /discovery is incomplete/
  );
});
