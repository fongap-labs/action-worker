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

test("deploy preflight routes trusted reads by repository without exposing App secrets to deployment", async () => {
  const text = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  const workflow = parse(text) as {
    jobs: {
      prepare: { steps: Step[] };
      deploy: { steps: Step[] };
    };
  };
  const steps = workflow.jobs.prepare.steps;
  const step = (name: string) => {
    const found = steps.find((item) => item.name === name);
    assert.ok(found, `missing step: ${name}`);
    return found;
  };
  const scope = step("Resolve deploy source API scope");
  assert.equal(scope.id, "api_scope");
  assert.equal(
    scope.env?.TARGET_REPOSITORY,
    "${{ github.event.client_payload.source_repository || inputs.source_repository }}"
  );
  const mint = step("Mint cross-repository deploy preflight read token");
  assert.equal(mint.id, "app_read");
  assert.equal(mint.if, undefined);
  assert.equal(mint.uses, "./.github/actions/mint-app-token");
  assert.equal(
    mint.with?.repositories,
    "${{ format('{0},{1}', github.event.repository.name, steps.api_scope.outputs.repository_name) }}"
  );
  assert.deepEqual(
    Object.keys(mint.with ?? {})
      .filter((key) => key.startsWith("permission-"))
      .sort(),
    [
      "permission-actions",
      "permission-checks",
      "permission-contents",
      "permission-issues",
      "permission-pull-requests",
      "permission-statuses",
    ]
  );
  for (const [key, value] of Object.entries(mint.with ?? {})) {
    if (key.startsWith("permission-")) assert.equal(value, "read");
  }
  const token =
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.token || steps.app_read.outputs.token }}";
  assert.equal(step("Request central CI for the source").env?.AW_CONTROL_TOKEN, token);
  assert.equal(step("Validate deploy source").env?.AW_CONTROL_TOKEN, token);
  assert.equal(
    step("Attest the source main write").env?.AW_CONTROL_TOKEN,
    "${{ steps.app_read.outputs.token }}"
  );
  assert.doesNotMatch(text, /secrets\.AW_CONTROL_TOKEN/);
  assert.equal(
    step("Attest the source main write").env?.AW_STATUS_API_TOKEN,
    "${{ steps.audit_status_app.outputs.token }}"
  );
  assert.equal(
    step("Validate deploy source").env?.AW_STATUS_API_TOKEN,
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.token || steps.app_read.outputs.token }}"
  );
  const scopedRunner = await readFile("scripts/run-scoped-deploy.ts", "utf8");
  assert.match(scopedRunner, /function isOrdinaryVariable/);
  assert.ok(scopedRunner.includes("AW_|GITHUB_|RUNNER_|ACTIONS_"));
  assert.match(scopedRunner, /const result: NodeJS\.ProcessEnv = \{\}/);
  assert.match(scopedRunner, /buildScopedDeployEnvironment/);
  assert.doesNotMatch(text, /for central_name in [^\\n]*AW_APP_PRIVATE_KEY/);
  assert.doesNotMatch(
    JSON.stringify(workflow.jobs.deploy),
    /secrets\\.AW_APP_PRIVATE_KEY|secrets\\.AW_APP_CLIENT_ID|steps\\.app_read\\.outputs\\.token/
  );
});

test("manual deploy resolves private source HEAD with pre-minted scoped App read token", async () => {
  const source = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  const workflow = parse(source) as { jobs: { prepare: { steps: Step[] } } };
  const steps = workflow.jobs.prepare.steps;
  const names = steps.map((step) => step.name);
  const scope = names.indexOf("Resolve deploy source API scope");
  const mint = names.indexOf("Mint cross-repository deploy preflight read token");
  const manual = names.indexOf("Resolve manual deploy request");
  assert.ok(scope >= 0 && scope < mint && mint < manual);
  const step = steps[manual];
  assert.equal(step?.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(step?.env?.AW_DEPLOY_SOURCE_READ_TOKEN, "${{ steps.app_read.outputs.token }}");
  assert.equal(step?.env?.AW_REPOSITORY_POLICY, undefined);
  assert.doesNotMatch(source, /AW_CHECKOUT_TOKEN: \$\{\{ secrets\.AW_CHECKOUT_TOKEN \}\}/);
  const manualBlock =
    source
      .split("      - name: Resolve manual deploy request")[1]
      ?.split("      - name: Mint deploy source CI status token")[0] ?? "";
  assert.match(manualBlock, /git ls-remote --exit-code/);
  assert.match(manualBlock, /no personal PAT fallback/);
  assert.doesNotMatch(manualBlock, /secrets\.AW_CHECKOUT_TOKEN/);
});

test("source deploy checkout uses no dedicated private token for public repositories", async () => {
  const source = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  const workflow = parse(source) as {
    jobs: {
      prepare: { outputs: Record<string, string>; steps: Step[] };
      deploy: { steps: Step[] };
    };
  };
  const prepare = workflow.jobs.prepare;
  const visibility = prepare.steps.find((step) => step.name === "Resolve deploy source visibility");
  assert.equal(visibility?.id, "source_visibility");
  assert.equal(visibility?.env?.GH_TOKEN, "${{ steps.app_read.outputs.token }}");
  assert.equal(prepare.outputs.is_private, "${{ steps.source_visibility.outputs.is_private }}");
  const deploy = workflow.jobs.deploy.steps;
  const find = (name: string) => deploy.find((step) => step.name === name);
  const privateSource = find("Checkout private deploy source");
  const publicSource = find("Checkout public deploy source");
  assert.ok(find("Validate deploy source visibility"));
  assert.equal(privateSource?.if, "needs.prepare.outputs.is_private == 'true'");
  assert.equal(publicSource?.if, "needs.prepare.outputs.is_private == 'false'");
  assert.equal(privateSource?.with?.token, "${{ secrets.AW_CHECKOUT_TOKEN }}");
  assert.equal(publicSource?.with?.token, "${{ github.token }}");
  assert.equal(privateSource?.with?.["persist-credentials"], false);
  assert.equal(publicSource?.with?.["persist-credentials"], false);
  const publicCheckout = source
    .split("      - name: Checkout public deploy source")[1]
    ?.split("      - name: Setup Node")[0];
  assert.ok(publicCheckout);
  assert.doesNotMatch(publicCheckout, /secrets\.AW_CHECKOUT_TOKEN/);
  assert.doesNotMatch(JSON.stringify(deploy), /secrets\.AW_APP_PRIVATE_KEY/);
});
