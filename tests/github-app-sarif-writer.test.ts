import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
  "working-directory"?: string;
};

test("CodeQL publisher requests only target Security events write permission", async () => {
  const source = await readFile(".github/workflows/security-scan-dispatch.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, { steps: Step[] }> };
  const steps = workflow.jobs.publish?.steps ?? [];
  const find = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, name);
    return step;
  };
  assert.doesNotMatch(source, /secrets\.AW_ADMIN_TOKEN/);
  const checkout = find("Checkout security publisher");
  assert.equal(checkout.with?.path, "control");
  const scope = find("Resolve SARIF target repository scope");
  assert.equal(scope.id, "sarif_scope");
  assert.equal(scope["working-directory"], checkout.with?.path);
  assert.equal(scope.run, "node scripts/resolve-github-api-scope.ts pr");
  assert.equal(scope.env?.TARGET_REPOSITORY, "${{ needs.prepare.outputs.repository }}");
  const mint = find("Mint target-only code scanning writer");
  assert.equal(mint.uses, "./control/.github/actions/mint-app-token");
  assert.equal(mint.with?.repositories, "${{ steps.sarif_scope.outputs.repository_name }}");
  assert.deepEqual(
    Object.entries(mint.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-security-events", "write"]]
  );
  assert.equal(
    find("Publish SARIF to target repository").env?.AW_SECURITY_EVENTS_API_TOKEN,
    "${{ steps.sarif_app.outputs.token }}"
  );
  const analyze = JSON.stringify(workflow.jobs.analyze ?? {});
  assert.doesNotMatch(analyze, /AW_APP_PRIVATE_KEY|AW_SECURITY_EVENTS_API_TOKEN/);
});

test("CodeQL publisher rejects using the broad admin PAT as a credential", async () => {
  const source = await readFile("scripts/publish-security-scan.ts", "utf8");
  assert.match(source, /process\.env\.AW_SECURITY_EVENTS_API_TOKEN/);
  assert.doesNotMatch(source, /process\.env\.AW_ADMIN_TOKEN/);
  assert.match(source, /no PAT fallback/);
  const action = parse(await readFile(".github/actions/mint-app-token/action.yml", "utf8")) as {
    inputs: Record<string, unknown>;
  };
  assert.ok(action.inputs["permission-security-events"]);
});
