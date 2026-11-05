import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

async function workflowSteps(
  path: string,
  job: string
): Promise<{ source: string; steps: Step[] }> {
  const source = await readFile(`.github/workflows/${path}.yml`, "utf8");
  const workflow = parse(source) as { jobs: Record<string, { steps?: Step[] }> };
  return { source, steps: workflow.jobs[job]?.steps ?? [] };
}

function step(steps: Step[], name: string): Step {
  const found = steps.find((entry) => entry.name === name);
  assert.ok(found, `Missing ${name}`);
  return found;
}

test("CI follow-up has separate status, control-read and dispatch App tokens", async () => {
  const { source, steps } = await workflowSteps("ci-follow-up", "follow-up");
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  assert.equal(step(steps, "Mint control read token").with?.["permission-contents"], "read");
  assert.equal(step(steps, "Mint control read token").with?.["permission-actions"], "read");
  assert.equal(step(steps, "Mint control read token").with?.["permission-pull-requests"], "read");
  assert.equal(step(steps, "Mint control read token").with?.["permission-issues"], "read");
  assert.equal(step(steps, "Mint CI evidence read token").with?.["permission-statuses"], "read");
  assert.equal(step(steps, "Mint control dispatch token").with?.["permission-contents"], "write");
  for (const name of [
    "Verify completed CI evidence and source revision",
    "Dispatch central security scan",
    "Attest deploy source main write",
    "Dispatch automatic deploy",
  ]) {
    assert.equal(
      step(steps, name).env?.AW_CONTROL_TOKEN,
      "${{ steps.control_read_app.outputs.token }}",
      name
    );
  }
});

test("branch pruning does not reuse the broad control PAT or status signing material", async () => {
  const { source, steps } = await workflowSteps("prune-stale-state", "branches");
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  assert.equal(step(steps, "Mint branch prune token").with?.["permission-contents"], "write");
  assert.equal(step(steps, "Mint branch prune token").with?.["permission-pull-requests"], "read");
  assert.equal(
    step(steps, "Prune fully subsumed branches").env?.AW_BRANCH_API_TOKEN,
    "${{ steps.branch_app.outputs.token }}"
  );
  assert.doesNotMatch(source, /AW_STATUS_KEYRING/);
});

test("tool release uses App read token independently from status verification", async () => {
  const { source, steps } = await workflowSteps("release-tool", "sync");
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  assert.equal(
    step(steps, "Mint tool distribution read token").with?.["permission-contents"],
    "read"
  );
  assert.equal(step(steps, "Mint release status read token").with?.["permission-statuses"], "read");
  assert.equal(
    step(steps, "Prepare verified tool artifact").env?.AW_CONTROL_TOKEN,
    "${{ steps.distribution_app.outputs.token }}"
  );
});
