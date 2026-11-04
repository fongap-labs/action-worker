import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  id?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
};

type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: { verify: { steps: Step[] } };
};

test("GitHub App diagnostic is manual-only, read-only and does not use personal tokens", async () => {
  const source = await readFile(".github/workflows/verify-github-app.yml", "utf8");
  const workflow = parse(source) as Workflow;

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(
    source,
    /AW_(?:CONTROL|STATUS|ISSUE|DISPATCH|CHECKOUT|ADMIN)_TOKEN/
  );

  const steps = workflow.jobs.verify.steps;
  const mint = steps.find((step) => step.id === "app");
  assert.ok(mint);
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
  );
  assert.equal(mint.with?.["permission-contents"], "read");
  assert.equal(mint.with?.["client-id"], "${{ vars.AW_APP_CLIENT_ID }}");
  assert.equal(mint.with?.["private-key"], "${{ secrets.AW_APP_PRIVATE_KEY }}");
  assert.equal(mint.with?.owner, "${{ github.repository_owner }}");
  assert.equal(mint.with?.repositories?.trim(), "action-worker\nmcp-hub");

  const check = steps.find((step) => step.run?.includes("gh api"));
  assert.ok(check);
  assert.equal(check.env?.GH_TOKEN, "${{ steps.app.outputs.token }}");
  assert.match(check.run ?? "", /contents\/README\.md/);
  assert.doesNotMatch(source, /permission-(?:contents|actions|issues|statuses): write/);
});
