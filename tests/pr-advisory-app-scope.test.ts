import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

test("PR advisory publication requests only issue and pull-request write permissions", async () => {
  const source = await readFile(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const workflow = parse(source) as {
    jobs: { govern: { steps: Array<{ name?: string; id?: string; uses?: string; with?: Record<string,string>; env?: Record<string,string> }> } };
  };
  const steps = workflow.jobs.govern.steps;
  const minted = steps.find((step) => step.id === "issue_app");
  const publish = steps.find((step) => step.name === "Publish PR review" && step.env?.GH_TOKEN);
  assert.equal(minted?.uses, "./.github/actions/mint-app-token");
  assert.deepEqual(
    Object.entries(minted?.with ?? {}).filter(([key]) => key.startsWith("permission-")).sort(),
    [
      ["permission-issues", "write"],
      ["permission-pull-requests", "write"],
    ]
  );
  assert.equal(publish?.env?.GH_TOKEN, "${{ steps.issue_app.outputs.token }}");
  assert.equal(publish?.env?.AW_ISSUE_API_TOKEN, "${{ steps.issue_app.outputs.token }}");
  assert.doesNotMatch(source, /secrets\.AW_ISSUE_TOKEN|secrets\.AW_CONTROL_TOKEN/);
});
