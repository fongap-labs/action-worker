import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
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
  assert.equal(scope.env?.TARGET_REPOSITORY, "${{ needs.prepare.outputs.repository }}");
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
    "${{ needs.prepare.outputs.is_private == 'true' && secrets.AW_CHECKOUT_TOKEN || '' }}";
  assert.equal(workflow.jobs.linux.secrets.checkout_token, expected);
  assert.equal(workflow.jobs.windows.secrets.checkout_token, expected);
});
