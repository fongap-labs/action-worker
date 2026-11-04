import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

test("signing bootstrap failure cannot prevent repository settings reconciliation", async () => {
  const source = await readFile(".github/workflows/apply-repository-settings.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<string, { steps: Step[]; needs?: string | string[]; environment?: string }>;
  };
  const control = workflow.jobs["apply-control-plane"];
  const bootstrap = workflow.jobs["bootstrap-signing"];
  const matrix = workflow.jobs["apply-managed"];
  assert.ok(control);
  assert.ok(bootstrap);
  assert.ok(matrix);
  assert.equal(
    control.steps.some((step) => step.name === "Bootstrap status signing keyring"),
    false
  );
  assert.equal(
    bootstrap.steps.some((step) => step.name === "Bootstrap status signing keyring"),
    true
  );
  assert.equal(bootstrap.environment, "admin-ops");
  assert.equal(bootstrap.needs, undefined);
  assert.equal(control.needs, undefined);
  assert.equal(matrix.needs, "resolve-managed");
  const signing = bootstrap.steps.find((step) => step.name === "Bootstrap status signing keyring");
  assert.equal(signing?.env?.GH_TOKEN, "${{ secrets.AW_ADMIN_TOKEN }}");
  assert.equal(signing?.env?.AW_STATUS_SIGNING_KEYS, "${{ secrets.AW_STATUS_SIGNING_KEYS }}");
  assert.equal(signing?.env?.AW_STATUS_TOKEN, "${{ secrets.AW_STATUS_TOKEN }}");
  assert.equal(
    signing?.env?.AW_DISPATCH_API_TOKEN,
    "${{ steps.bootstrap_dispatch.outputs.token }}"
  );
  assert.ok(bootstrap.steps.some((step) => step.name === "Mint status bootstrap dispatch token"));
});
