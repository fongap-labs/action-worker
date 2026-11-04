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

test("deploy preflight routes trusted reads by repository without exposing App secrets to deployment", async () => {
  const text = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  const workflow = parse(text) as {
    jobs: {
      prepare: { steps: Step[] };
      deploy: { steps: Step[] };
    };
  };
  const steps = workflow.jobs.prepare.steps;
  const step = (name: string) => {
    const found = steps.find((item) => item.name === name);
    assert.ok(found, `missing step: ${name}`);
    return found;
  };
  const scope = step("Resolve deploy source API scope");
  assert.equal(scope.id, "api_scope");
  assert.equal(
    scope.env?.TARGET_REPOSITORY,
    "${{ steps.manual_request.outputs.source_repository || github.event.client_payload.source_repository }}"
  );
  const mint = step("Mint cross-repository deploy preflight read token");
  assert.equal(mint.id, "app_read");
  assert.equal(mint.if, "steps.api_scope.outputs.is_control_repository == 'false'");
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
  );
  assert.equal(
    mint.with?.repositories?.trim(),
    "${{ github.event.repository.name }}\n${{ steps.api_scope.outputs.repository_name }}"
  );
  assert.deepEqual(
    Object.keys(mint.with ?? {})
      .filter((key) => key.startsWith("permission-"))
      .sort(),
    [
      "permission-actions",
      "permission-checks",
      "permission-contents",
      "permission-issues",
      "permission-pull-requests",
      "permission-statuses",
    ]
  );
  for (const [key, value] of Object.entries(mint.with ?? {})) {
    if (key.startsWith("permission-")) assert.equal(value, "read");
  }
  const token =
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.token || steps.app_read.outputs.token }}";
  assert.equal(step("Request central CI for the source").env?.AW_CONTROL_TOKEN, token);
  assert.equal(step("Validate deploy source").env?.AW_CONTROL_TOKEN, token);
  assert.equal(
    step("Attest the source main write").env?.AW_STATUS_TOKEN,
    "${{ secrets.AW_STATUS_TOKEN }}"
  );
  assert.equal(
    step("Validate deploy source").env?.AW_STATUS_TOKEN,
    "${{ secrets.AW_STATUS_TOKEN }}"
  );
  assert.doesNotMatch(
    JSON.stringify(workflow.jobs.deploy),
    /AW_APP_PRIVATE_KEY|AW_APP_CLIENT_ID|steps\.app_read\.outputs\.token/
  );
});
