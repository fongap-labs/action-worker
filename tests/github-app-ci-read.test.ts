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

test("MCP Hub central CI uses a scoped App token only for trusted read operations", async () => {
  const source = await readFile(".github/workflows/central-ci-dispatch.yml", "utf8");
  const parsed = parse(source) as {
    jobs: { prepare: { steps: Step[] }; finalize: { steps: Step[] } };
  };
  const steps = parsed.jobs.prepare.steps;
  const step = (name: string) => {
    const found = steps.find((item) => item.name === name);
    assert.ok(found, `missing step: ${name}`);
    return found;
  };

  const mint = step("Mint MCP Hub central CI read token");
  assert.equal(mint.id, "mcp_ci_read");
  assert.equal(mint.if, "github.event.client_payload.repository == 'fongap-labs/mcp-hub'");
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
  );
  assert.equal(mint.with?.["client-id"], "${{ vars.AW_APP_CLIENT_ID }}");
  assert.equal(mint.with?.["private-key"], "${{ secrets.AW_APP_PRIVATE_KEY }}");
  assert.equal(mint.with?.repositories?.trim(), "action-worker\nmcp-hub");
  assert.equal(mint.with?.["permission-contents"], "read");
  assert.equal(mint.with?.["permission-actions"], "read");
  assert.deepEqual(
    Object.keys(mint.with ?? {})
      .filter((key) => key.startsWith("permission-"))
      .sort(),
    ["permission-actions", "permission-contents"]
  );

  const scoped =
    "${{ (github.event.client_payload.repository == 'fongap-labs/mcp-hub' && steps.mcp_ci_read.outputs.token) || (github.event.client_payload.repository != 'fongap-labs/mcp-hub' && secrets.AW_CONTROL_TOKEN) }}";
  for (const name of ["Resolve target visibility", "Resolve branch CI request"]) {
    assert.equal(step(name).env?.GH_TOKEN, scoped, name);
  }
  for (const name of ["Resolve branch CI request", "Resolve CI capabilities"]) {
    assert.equal(step(name).env?.AW_CONTROL_TOKEN, scoped, name);
  }

  // Status attestation and writes remain bound to the stable legacy status secret.
  assert.equal(
    step("Resolve branch CI request").env?.AW_STATUS_TOKEN,
    "${{ secrets.AW_STATUS_TOKEN }}"
  );
  assert.equal(
    step("Attach Main CI lease to active Central CI run").env?.AW_STATUS_TOKEN,
    "${{ secrets.AW_STATUS_TOKEN }}"
  );
  const publish = parsed.jobs.finalize.steps.find((item) => item.name === "Publish target status");
  assert.equal(publish?.env?.AW_STATUS_TOKEN, "${{ secrets.AW_STATUS_TOKEN }}");
});
