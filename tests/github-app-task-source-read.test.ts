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

test("task source resolves policy before minting a scoped App read token", async () => {
  const source = await readFile(".github/workflows/task-source-dispatch.yml", "utf8");
  const workflow = parse(source) as { jobs: { dispatch: { steps: Step[] } } };
  const steps = workflow.jobs.dispatch.steps;
  const step = (name: string) => steps.find((entry) => entry.name === name);
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  const scope = step("Resolve task source read scope");
  assert.equal(scope?.id, "source_read_scope");
  assert.equal(
    scope?.env?.TARGET_REPOSITORY,
    "${{ github.event.client_payload.repository || inputs.repository }}"
  );
  const mint = step("Mint task source read token");
  assert.equal(mint?.id, "app_read");
  assert.deepEqual(
    Object.entries(mint?.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [
      ["permission-contents", "read"],
      ["permission-actions", "read"],
      ["permission-pull-requests", "read"],
      ["permission-issues", "read"],
    ]
  );
  const token = "${{ steps.app_read.outputs.token }}";
  assert.equal(step("Resolve source request")?.env?.GH_TOKEN, token);
  assert.equal(step("Request central CI for the source")?.env?.AW_CONTROL_TOKEN, token);
  assert.equal(step("Attest the source main write")?.env?.AW_CONTROL_TOKEN, token);
  assert.equal(step("Checkout source repository")?.with?.token, token);
  assert.equal(step("Checkout source repository")?.with?.["persist-credentials"], false);
});
