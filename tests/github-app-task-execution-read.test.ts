import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  if?: string;
  id?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};

test("task validation reads only with scoped App token and no control PAT", async () => {
  const source = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, { steps: Step[] }> };
  const validation = workflow.jobs.validate?.steps ?? [];
  const find = (name: string) => validation.find((step) => step.name === name);
  assert.equal(find("Resolve task source read scope")?.id, "task_scope");
  const mint = find("Mint task validation read token");
  assert.equal(mint?.with?.["permission-contents"], "read");
  assert.equal(mint?.with?.["permission-actions"], "read");
  assert.equal(mint?.with?.["permission-pull-requests"], "read");
  assert.equal(mint?.with?.["permission-statuses"], "read");
  assert.equal(mint?.with?.["permission-issues"], "read");
  assert.equal(
    find("Validate task source")?.env?.AW_CONTROL_TOKEN,
    "${{ steps.task_read_app.outputs.token }}"
  );
  assert.equal(
    find("Resolve task source visibility")?.env?.GH_TOKEN,
    "${{ steps.task_read_app.outputs.token }}"
  );
  assert.doesNotMatch(source.split("  execute:")[0] ?? "", /secrets\.AW_CONTROL_TOKEN/);
});

test("task execution never receives the App private key or broad control checkout credential", async () => {
  const source = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, { steps: Step[] }> };
  const steps = workflow.jobs.execute?.steps ?? [];
  const find = (name: string) => steps.find((step) => step.name === name);
  assert.equal(steps.some((step) => step.name?.includes("Mint")), false);
  assert.equal(
    find("Require dedicated private task checkout credential")?.if,
    "needs.validate.outputs.is_private == 'true'"
  );
  assert.equal(
    find("Checkout private task source")?.with?.token,
    "${{ secrets.AW_CHECKOUT_TOKEN }}"
  );
  assert.equal(
    find("Checkout public task source")?.with?.token,
    "${{ github.token }}"
  );
  assert.equal(find("Checkout private task source")?.with?.["persist-credentials"], false);
  assert.equal(find("Checkout public task source")?.with?.["persist-credentials"], false);
  assert.doesNotMatch(
    source,
    /- name: Checkout (private|public) task source[\s\S]*?token: \$\{\{ secrets\.AW_CONTROL_TOKEN/
  );
});
