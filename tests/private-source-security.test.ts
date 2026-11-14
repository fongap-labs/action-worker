import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
};

test("private source security runs in caller context with read-only permissions", async () => {
  const source = await readFile(".github/workflows/private-source-security.yml", "utf8");
  const workflow = parse(source) as {
    on: { workflow_call: { inputs: Record<string, unknown> } };
    permissions: { contents: string };
    jobs: { security: { steps: Step[] } };
  };
  assert.ok(workflow.on.workflow_call);
  assert.equal(workflow.permissions.contents, "read");
  const steps = workflow.jobs.security.steps;
  const verify = steps.find(
    (step) => step.name === "Verify caller and immutable pull request identity"
  );
  assert.ok(verify);
  assert.match(verify.run ?? "", /REQUESTED_HEAD.*EVENT_HEAD/);
  assert.match(verify.run ?? "", /REQUESTED_BASE.*EVENT_BASE/);
  assert.match(verify.run ?? "", /SOURCE_REPOSITORY/);
  assert.match(verify.run ?? "", /IS_PRIVATE/);
  const sourceCheckout = steps.find(
    (step) => step.name === "Checkout private caller source at pinned head"
  );
  assert.ok(sourceCheckout);
  assert.equal(sourceCheckout.with?.ref, "${{ inputs.head_sha }}");
  assert.equal(sourceCheckout.with?.["persist-credentials"], false);
  const control = steps.find((step) => step.name === "Checkout central security rules");
  assert.ok(control);
  assert.equal(control.with?.repository, "fongap-labs/action-worker");
  assert.equal(control.with?.["persist-credentials"], false);
});

test("private source security uses shared scanners and never receives root secrets", async () => {
  const source = await readFile(".github/workflows/private-source-security.yml", "utf8");
  assert.match(source, /node control\/scripts\/validate-security\.ts/);
  assert.match(source, /node control\/scripts\/central-secret-scan\.ts/);
  assert.match(source, /TARGET_PRIVATE: "true"/);
  assert.match(source, /AW_GITLEAKS_MODE: enforce/);
  assert.doesNotMatch(source, /secrets\.|AW_APP_PRIVATE_KEY|permission-contents: write/);
  assert.doesNotMatch(source, /continue-on-error: true/);
  assert.doesNotMatch(source, /repository_dispatch:/);
});
