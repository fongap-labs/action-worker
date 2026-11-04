import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};

test("PR API reads use GITHUB_TOKEN locally and a scoped App token across managed repositories", async () => {
  const source = await readFile(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const workflow = parse(source) as {
    permissions: Record<string, string>;
    jobs: { govern: { steps: Step[] }; "resolve-unfinished": { steps: Step[] } };
  };
  const steps = workflow.jobs.govern.steps;
  const findStep = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, `missing step: ${name}`);
    return step;
  };
  const scope = findStep("Resolve PR API scope");
  assert.equal(scope.id, "api_scope");
  assert.match(scope.env?.TARGET_REPOSITORY ?? "", /steps\.payload\.outputs\.repository/);
  const mint = findStep("Mint PR read token");
  assert.equal(mint.id, "app_read");
  assert.equal(mint.if, undefined);
  assert.equal(mint.uses, "./.github/actions/mint-app-token");
  assert.equal(
    mint.with?.repositories,
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.event.repository.name || format('{0},{1}', github.event.repository.name, steps.api_scope.outputs.repository_name) }}"
  );
  assert.equal(mint.with?.owner, "${{ steps.api_scope.outputs.owner }}");
  assert.deepEqual(
    Object.keys(mint.with ?? {})
      .filter((key) => key.startsWith("permission-"))
      .sort(),
    ["permission-actions", "permission-contents", "permission-pull-requests", "permission-statuses"]
  );
  assert.deepEqual(
    [
      mint.with?.["permission-actions"],
      mint.with?.["permission-contents"],
      mint.with?.["permission-pull-requests"],
      mint.with?.["permission-statuses"],
    ],
    ["read", "read", "read", "read"]
  );

  const readToken =
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.token || steps.app_read.outputs.token }}";
  for (const name of [
    "Validate control credential",
    "Fetch PR facts",
    "Resolve checked-out PR facts",
  ]) {
    assert.equal(findStep(name).env?.GH_TOKEN, readToken, name);
  }
  assert.equal(workflow.permissions["pull-requests"], "read");
  assert.equal(workflow.permissions.statuses, "read");
  assert.equal(
    findStep("Mark governance in progress").env?.AW_STATUS_API_TOKEN,
    "${{ steps.status_pending_app.outputs.token }}"
  );
  assert.equal(findStep("Checkout target PR").with?.token, "${{ steps.app_read.outputs.token }}");
  assert.equal(findStep("Enforce PR trust").env?.GH_TOKEN, "${{ steps.app_read.outputs.token }}");
  assert.equal(
    findStep("Collect CI evidence").env?.AW_CONTROL_TOKEN,
    "${{ steps.app_read.outputs.token }}"
  );
  const finalRead = findStep("Mint final governance read token");
  assert.equal(finalRead.with?.["permission-actions"], "read");
  assert.equal(finalRead.with?.["permission-statuses"], "read");
  assert.equal(
    findStep("Resolve governance ownership").env?.GH_TOKEN,
    "${{ steps.final_read_app.outputs.token }}"
  );
  assert.equal(
    steps.find((step) => step.name === "Publish PR review" && step.env?.AW_CONTROL_TOKEN)?.env
      ?.AW_CONTROL_TOKEN,
    "${{ steps.final_read_app.outputs.token }}"
  );
  assert.equal(
    workflow.jobs["resolve-unfinished"].steps.find(
      (step) => step.name === "Resolve unfinished PR governance"
    )?.env?.AW_CONTROL_TOKEN,
    "${{ steps.unfinished_read_app.outputs.token }}"
  );
  assert.doesNotMatch(
    source,
    /secrets\.AW_CONTROL_TOKEN/,
    "governance must not use the personal control token"
  );
});
