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

test("failed CI preparation verifies the current PR with scoped App read credentials", async () => {
  const source = await readFile(".github/workflows/central-ci-dispatch.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const steps = workflow.jobs["prepare-failure"]?.steps ?? [];
  const find = (name: string) => steps.find((entry) => entry.name === name);
  const mint = find("Mint failed CI PR read token");
  assert.equal(mint?.id, "failed_ci_read_app");
  assert.equal(mint?.with?.repositories, "${{ steps.status_scope.outputs.repository_name }}");
  assert.deepEqual(
    Object.entries(mint?.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-pull-requests", "read"]]
  );
  const publish = find("Publish failed CI Evidence for the current head");
  assert.equal(publish?.env?.GH_TOKEN, "${{ steps.failed_ci_read_app.outputs.token }}");
  assert.equal(publish?.env?.AW_CONTROL_TOKEN, "${{ steps.failed_ci_read_app.outputs.token }}");
  assert.equal(publish?.env?.AW_STATUS_API_TOKEN, "${{ steps.status_app.outputs.token }}");
  const section =
    source.split("  prepare-failure:")[1]?.split("  # Runs only after a passing CI Evidence")[0] ??
    "";
  assert.doesNotMatch(section, /secrets\.AW_CONTROL_TOKEN/);
});
