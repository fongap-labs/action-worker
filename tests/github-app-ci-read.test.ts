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

test("Central CI reads use GITHUB_TOKEN for the control repository and a scoped App token otherwise", async () => {
  const source = await readFile(".github/workflows/central-ci-dispatch.yml", "utf8");
  const parsed = parse(source) as {
    permissions: Record<string, string>;
    jobs: { prepare: { steps: Step[] }; finalize: { steps: Step[] } };
  };
  const steps = parsed.jobs.prepare.steps;
  const step = (name: string) => {
    const found = steps.find((item) => item.name === name);
    assert.ok(found, `missing step: ${name}`);
    return found;
  };
  const scope = step("Resolve central CI API scope");
  assert.equal(scope.id, "api_scope");
  assert.equal(scope.env?.TARGET_REPOSITORY, "${{ github.event.client_payload.repository }}");
  const mint = step("Mint cross-repository central CI read token");
  assert.equal(mint.id, "app_read");
  assert.equal(mint.if, "steps.api_scope.outputs.is_control_repository == 'false'");
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
  );
  assert.equal(mint.with?.["client-id"], "${{ vars.AW_APP_CLIENT_ID }}");
  assert.equal(mint.with?.["private-key"], "${{ secrets.AW_APP_PRIVATE_KEY }}");
  assert.equal(
    mint.with?.repositories,
    "${{ format('{0},{1}', github.event.repository.name, steps.api_scope.outputs.repository_name) }}"
  );
  assert.equal(mint.with?.owner, "${{ steps.api_scope.outputs.owner }}");
  assert.deepEqual(
    Object.keys(mint.with ?? {})
      .filter((key) => key.startsWith("permission-"))
      .sort(),
    ["permission-actions", "permission-contents", "permission-pull-requests", "permission-statuses"]
  );
  assert.equal(mint.with?.["permission-contents"], "read");
  assert.equal(mint.with?.["permission-actions"], "read");
  assert.equal(mint.with?.["permission-pull-requests"], "read");
  assert.equal(mint.with?.["permission-statuses"], "read");

  const scoped =
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.token || steps.app_read.outputs.token }}";
  for (const name of [
    "Resolve target visibility",
    "Resolve branch CI request",
    "Validate control credential",
    "Enforce PR trust",
    "Resolve PR facts",
    "Pin PR merge snapshot",
  ]) {
    assert.equal(step(name).env?.GH_TOKEN, scoped, name);
  }
  for (const name of [
    "Resolve branch CI request",
    "Resolve PR CI control",
    "Resolve CI capabilities",
  ]) {
    assert.equal(step(name).env?.AW_CONTROL_TOKEN, scoped, name);
  }
  assert.equal(parsed.permissions["pull-requests"], "read");
  assert.equal(parsed.permissions.statuses, "read");
  const prepare = source.split("\n  linux:\n")[0] ?? "";
  assert.doesNotMatch(prepare, /secrets\.AW_CONTROL_TOKEN/);

  assert.equal(step("Resolve branch CI request").env?.AW_STATUS_TOKEN, undefined);
  assert.equal(
    step("Resolve branch CI request").env?.AW_STATUS_SIGNING_KEYS,
    "${{ secrets.AW_STATUS_SIGNING_KEYS }}"
  );
  assert.equal(
    step("Attach Main CI lease to active Central CI run").env?.AW_STATUS_TOKEN,
    undefined
  );
  const publish = parsed.jobs.finalize.steps.find((item) => item.name === "Publish target status");
  assert.equal(publish?.env?.AW_STATUS_API_TOKEN, "${{ steps.status_app.outputs.token }}");
});
