import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  if?: string;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
};

type Workflow = {
  on: {
    workflow_dispatch: {
      inputs: { confirm: { type: string; default: boolean; required: boolean } };
    };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { if?: string; environment?: string; needs?: string; steps: Step[] }>;
};

test("manual signing recovery is a protected entry, not a manual maintenance job", async () => {
  const source = await readFile(".github/workflows/status-signing-recovery.yml", "utf8");
  const workflow = parse(source) as Workflow;
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm.type, "boolean");
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm.default, false);
  assert.equal(workflow.concurrency.group, "apply-repository-settings");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), ["bootstrap"]);
  const bootstrap = workflow.jobs.bootstrap;
  assert.ok(bootstrap);
  assert.deepEqual(bootstrap.environment, { name: "admin-ops", deployment: false });
  assert.equal(bootstrap.if, "github.ref == 'refs/heads/main'");
  assert.equal(bootstrap.needs, undefined);
  const confirm = bootstrap.steps.find((step) => step.name === "Require operator confirmation");
  assert.equal(confirm?.if, undefined);
  assert.equal(confirm?.env?.RECOVERY_CONFIRMED, "${{ inputs.confirm }}");
  const prerequisite = bootstrap.steps.find(
    (step) => step.name === "Confirm signing recovery is needed"
  );
  assert.equal(
    prerequisite?.env?.AW_LEGACY_VERIFIER_PRESENT,
    "${{ secrets.AW_STATUS_TOKEN != '' }}"
  );
  assert.equal(prerequisite?.env?.AW_KEYRING_PRESENT, "${{ secrets.AW_STATUS_KEYRING != '' }}");

  const maintenance = parse(
    await readFile(".github/workflows/apply-repository-settings.yml", "utf8")
  ) as { on: Record<string, unknown> };
  assert.equal(maintenance.on.workflow_dispatch, undefined);
});

test("manual signing recovery preserves legacy verifiers and refuses bypasses", async () => {
  const source = await readFile(".github/workflows/status-signing-recovery.yml", "utf8");
  const workflow = parse(source) as Workflow;
  const steps = workflow.jobs.bootstrap?.steps ?? [];
  const find = (name: string) => {
    const step = steps.find((entry) => entry.name === name);
    assert.ok(step, name);
    return step;
  };
  const token = find("Mint status bootstrap dispatch token");
  assert.equal(token.with?.repositories, "${{ github.event.repository.name }}");
  assert.equal(token.with?.["permission-contents"], "write");
  assert.equal(
    find("Bootstrap status signing keyring").env?.GH_TOKEN,
    "${{ secrets.AW_ADMIN_TOKEN }}"
  );
  const signing = find("Bootstrap status signing keyring");
  assert.equal(signing.env?.AW_STATUS_TOKEN, "${{ secrets.AW_STATUS_TOKEN }}");
  assert.equal(signing.env?.AW_STATUS_KEYRING, "${{ secrets.AW_STATUS_KEYRING }}");
  assert.equal(signing.env?.AW_STATUS_SIGNING_KEY_ID, "k1");
  assert.equal(signing.env?.AW_BOOTSTRAP_READ_TOKEN, "${{ github.token }}");
  assert.equal(signing.env?.AW_DISPATCH_API_TOKEN, "${{ steps.bootstrap_dispatch.outputs.token }}");
  assert.equal(signing["continue-on-error"], undefined);
  assert.doesNotMatch(source, /toJSON\s*\(\s*secrets\s*\)|env:\s*\$\{\{\s*secrets\s*\}\}/);
  assert.match(source, /this recovery entry must not rotate an existing keyring/);
});
