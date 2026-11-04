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

test("Release Build uses GitHub App for preflight and a dedicated read-only checkout credential", async () => {
  const source = await readFile(".github/workflows/release-app.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  const prepare = workflow.jobs.prepare?.steps ?? [];
  const read = prepare.find((step) => step.name === "Mint release source read token");
  assert.equal(read?.id, "app_read");
  assert.equal(read?.with?.["permission-contents"], "read");
  assert.equal(read?.with?.["permission-actions"], "read");
  assert.equal(read?.with?.["permission-statuses"], "read");
  for (const name of [
    "Resolve release build ingress",
    "Request central CI for the source",
    "Attest the source main write",
    "Validate release build request",
  ]) {
    const step = prepare.find((candidate) => candidate.name === name);
    assert.equal(step?.env?.AW_CONTROL_TOKEN, "${{ steps.app_read.outputs.token }}", name);
  }
  for (const [job, name] of [
    ["build", "Checkout source"],
    ["publish", "Checkout release source"],
  ]) {
    const step = workflow.jobs[job]?.steps.find((candidate) => candidate.name === name);
    assert.equal(step?.with?.token, "${{ secrets.AW_CHECKOUT_TOKEN }}", job);
    assert.equal(step?.with?.["persist-credentials"], false);
  }
});
