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

test("only MCP Hub PR fact reads use a scoped GitHub App token", async () => {
  const source = await readFile(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const workflow = parse(source) as { jobs: { govern: { steps: Step[] } } };
  const steps = workflow.jobs.govern.steps;
  const findStep = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, `missing step: ${name}`);
    return step;
  };
  const mint = findStep("Mint MCP Hub read-only GitHub App token");
  assert.equal(mint.id, "mcp_app_read");
  assert.equal(mint.if, "steps.payload.outputs.repository == 'fongap-labs/mcp-hub'");
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
  );
  assert.equal(mint.with?.repositories, "mcp-hub");
  assert.equal(mint.with?.["permission-contents"], "read");
  assert.equal(mint.with?.["permission-pull-requests"], "read");
  assert.equal(mint.with?.["permission-actions"], "read");
  assert.deepEqual(
    Object.keys(mint.with ?? {})
      .filter((key) => key.startsWith("permission-"))
      .sort(),
    ["permission-actions", "permission-contents", "permission-pull-requests"]
  );

  // The two branches are exclusive. A missing App token for MCP Hub never falls back to a PAT.
  const readToken =
    "${{ (steps.payload.outputs.repository == 'fongap-labs/mcp-hub' && steps.mcp_app_read.outputs.token) || (steps.payload.outputs.repository != 'fongap-labs/mcp-hub' && secrets.AW_CONTROL_TOKEN) }}";
  for (const name of [
    "Validate control credential",
    "Fetch PR facts",
    "Resolve checked-out PR facts",
  ]) {
    assert.equal(findStep(name).env?.GH_TOKEN, readToken, name);
  }

  assert.equal(
    findStep("Mark governance in progress").env?.AW_STATUS_TOKEN,
    "${{ secrets.AW_STATUS_TOKEN }}"
  );
  assert.equal(findStep("Checkout target PR").with?.token, "${{ secrets.AW_CONTROL_TOKEN }}");
});
