import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  "working-directory"?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};

test("Central CI security scan gets a target-only App read token, not private checkout PAT", async () => {
  const source = await readFile(".github/workflows/central-ci-dispatch.yml", "utf8");
  const workflow = parse(source) as { jobs: { security: { steps: Step[] } } };
  const steps = workflow.jobs.security.steps;
  const find = (name: string) => {
    const step = steps.find((item) => item.name === name);
    assert.ok(step, name);
    return step;
  };
  const scope = find("Resolve private security checkout scope");
  const mint = find("Mint private security checkout read token");
  assert.equal(scope.id, "security_scope");
  assert.equal(
    scope.env?.TARGET_REPOSITORY,
    "${{ format('{0}/{1}', needs.prepare.outputs.owner, needs.prepare.outputs.repository_name) }}"
  );
  assert.equal(scope.if, "needs.prepare.outputs.is_private == 'true'");
  assert.equal(mint.id, "security_read_app");
  assert.equal(mint.if, scope.if);
  assert.equal(mint.uses, "./.github/actions/mint-app-token");
  assert.equal(mint.with?.repositories, "${{ steps.security_scope.outputs.repository_name }}");
  assert.deepEqual(
    Object.entries(mint.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-contents", "read"]]
  );
  assert.equal(
    find("Require private checkout token").env?.CHECKOUT_TOKEN,
    "${{ steps.security_read_app.outputs.token }}"
  );
  assert.equal(
    find("Checkout private target source").with?.token,
    "${{ steps.security_read_app.outputs.token }}"
  );
  assert.equal(find("Checkout private target source").with?.["persist-credentials"], false);
  const sec = source.split("\n  security:\n")[1]?.split("\n  windows:\n")[0] ?? "";
  assert.doesNotMatch(sec, /secrets\.AW_CHECKOUT_TOKEN|secrets\.AW_CONTROL_TOKEN/);
  assert.equal(
    steps.some((step) => step.name === "Validate security gate"),
    true
  );
});

test("Central CI untrusted test sandboxes retain isolated checkout only", async () => {
  const source = await readFile(".github/workflows/central-ci-dispatch.yml", "utf8");
  const workflow = parse(source) as {
    jobs: {
      linux: { secrets: Record<string, string> };
      windows: { secrets: Record<string, string> };
    };
  };
  const expected =
    "${{ needs.prepare.outputs.is_private == 'true' && secrets.AW_APP_PRIVATE_KEY || '' }}";
  assert.equal(workflow.jobs.linux.secrets.app_private_key, expected);
  assert.equal(workflow.jobs.windows.secrets.app_private_key, expected);
});

test("controller dev dependency drift gate runs trusted main policy before candidate code", async () => {
  const source = await readFile(".github/workflows/validate-ci.yml", "utf8");
  const workflow = parse(source) as { jobs: { static: { steps: Step[] } } };
  const steps = workflow.jobs.static.steps;
  const find = (name: string) => {
    const step = steps.find((item) => item.name === name);
    assert.ok(step, name);
    return step;
  };
  const checkout = find("Checkout trusted dev runtime policy");
  const gate = find("Enforce trusted dev dependency version drift gate");
  const cleanup = find("Remove trusted dev runtime checkout");
  const install = find("Install TypeScript toolchain");
  const mainGate = find("Enforce central dependency version drift gate");
  assert.equal(checkout.if, "inputs.dev_merge_sha != ''");
  assert.equal(checkout.with?.ref, "${{ github.sha }}");
  assert.equal(checkout.with?.path, "runtime-control");
  assert.equal(checkout.with?.["persist-credentials"], false);
  assert.equal(gate.if, checkout.if);
  assert.equal(gate["working-directory"], "runtime-control");
  assert.deepEqual(gate.env, {
    BASE_SHA: "${{ inputs.dev_base_sha }}",
    MERGE_SHA: "${{ inputs.dev_merge_sha }}",
  });
  assert.match(gate.run ?? "", /npm ci --ignore-scripts/);
  assert.match(
    gate.run ?? "",
    /node scripts\/validate-dependency-drift\.ts local "\$GITHUB_REPOSITORY" dev "\$BASE_SHA" "\$MERGE_SHA" "\$GITHUB_WORKSPACE"/
  );
  assert.equal(cleanup.if, checkout.if);
  assert.equal(cleanup.run, "rm -rf runtime-control");
  const order = [checkout, gate, cleanup, install, mainGate].map((step) => steps.indexOf(step));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.equal(mainGate.if, "github.event_name == 'pull_request' && inputs.dev_merge_sha == ''");
});
