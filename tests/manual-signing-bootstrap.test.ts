import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  steps?: Array<{ name?: string; env?: Record<string, string>; "continue-on-error"?: boolean }>;
};

test("manual signing recovery selects only protected signing job by default", async () => {
  const source = await readFile(".github/workflows/apply-repository-settings.yml", "utf8");
  const workflow = parse(source) as {
    on: {
      workflow_dispatch: {
        inputs: { scope: { default: string; options: string[]; required: boolean } };
      };
    };
    jobs: Record<string, Job>;
  };
  const scope = workflow.on.workflow_dispatch.inputs.scope;
  assert.equal(scope.default, "signing-only");
  assert.equal(scope.required, true);
  assert.deepEqual(scope.options, ["signing-only", "all"]);
  const condition = "github.event_name != 'workflow_dispatch' || inputs.scope == 'all'";
  assert.equal(workflow.jobs["apply-control-plane"]?.if, condition);
  assert.equal(workflow.jobs["resolve-managed"]?.if, condition);
  assert.equal(workflow.jobs["apply-managed"]?.needs, "resolve-managed");
  const signing = workflow.jobs["bootstrap-signing"];
  assert.ok(signing);
  assert.equal(signing.environment, "admin-ops");
  assert.equal(signing.if, undefined);
  assert.equal(
    signing.steps?.some((step) => step.name === "Bootstrap status signing keyring"),
    true
  );
});

test("manual signing recovery uses existing legacy verifier without disabling signing", async () => {
  const source = await readFile(".github/workflows/apply-repository-settings.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, Job> };
  const bootstrap = workflow.jobs["bootstrap-signing"];
  const keys = bootstrap.steps?.find((step) => step.name === "Bootstrap status signing keyring");
  assert.equal(keys?.env?.AW_STATUS_TOKEN, "${{ secrets.AW_STATUS_TOKEN }}");
  assert.equal(keys?.env?.AW_STATUS_SIGNING_KEYS, "${{ secrets.AW_STATUS_SIGNING_KEYS }}");
  assert.equal(keys?.env?.GH_TOKEN, "${{ secrets.AW_ADMIN_TOKEN }}");
  assert.equal(keys?.["continue-on-error"], undefined);
});
