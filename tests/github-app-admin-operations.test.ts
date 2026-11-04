import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type Job = { steps: Step[] };

test("admin settings and signing use distinct repository-scoped GitHub App credentials", async () => {
  const workflow = parse(
    await readFile(".github/workflows/apply-repository-settings.yml", "utf8")
  ) as { jobs: Record<string, Job> };
  const steps = workflow.jobs["apply-control-plane"]?.steps ?? [];
  const find = (name: string) => {
    const entry = steps.find((step) => step.name === name);
    assert.ok(entry, `Missing ${name}`);
    return entry;
  };

  const admin = find("Mint control settings administration token");
  const variables = find("Mint control AI Review variable token");
  const secrets = find("Mint control status signing secret token");
  for (const entry of [admin, variables, secrets]) {
    assert.equal(entry.uses, "./.github/actions/mint-app-token");
    assert.equal(entry.with?.repositories, "${{ github.event.repository.name }}");
  }
  assert.deepEqual(
    Object.entries(admin.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-administration", "write"]]
  );
  assert.deepEqual(
    Object.entries(variables.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-variables", "write"]]
  );
  assert.deepEqual(
    Object.entries(secrets.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-secrets", "write"]]
  );
  assert.equal(find("Apply managed settings").env?.GH_TOKEN, "${{ steps.admin_app.outputs.token }}");
  assert.equal(find("Apply AI Review model").env?.GH_TOKEN, "${{ steps.review_vars_app.outputs.token }}");
  const bootstrap = find("Bootstrap status signing keyring");
  assert.equal(bootstrap.env?.GH_TOKEN, "${{ steps.signing_secrets_app.outputs.token }}");
  assert.equal(bootstrap.env?.AW_STATUS_TOKEN, "${{ secrets.AW_STATUS_TOKEN }}");
  assert.equal(bootstrap.env?.AW_STATUS_SIGNING_KEYS, "${{ secrets.AW_STATUS_SIGNING_KEYS }}");
});

test("managed repository administration token is scoped to exactly the matrix repository", async () => {
  const source = await readFile(".github/workflows/apply-repository-settings.yml", "utf8");
  assert.doesNotMatch(source, /secrets\.AW_ADMIN_TOKEN/);
  const workflow = parse(source) as { jobs: Record<string, Job> };
  const steps = workflow.jobs["apply-managed"]?.steps ?? [];
  const mint = steps.find((step) => step.name === "Mint managed settings administration token");
  assert.equal(mint?.with?.repositories, "${{ matrix.repository }}");
  assert.equal(mint?.with?.["permission-administration"], "write");
  const apply = steps.find((step) => step.name === "Apply managed settings");
  assert.equal(apply?.env?.GH_TOKEN, "${{ steps.admin_app.outputs.token }}");
});

test("App token composite forwards only the explicitly selected admin permissions", async () => {
  const source = await readFile(".github/actions/mint-app-token/action.yml", "utf8");
  const action = parse(source) as {
    inputs: Record<string, unknown>;
    runs: { steps: Array<{ with?: Record<string, string> }> };
  };
  const forwarded = action.runs.steps[0]?.with ?? {};
  for (const permission of ["administration", "variables", "secrets"]) {
    const key = `permission-${permission}`;
    assert.ok(action.inputs[key], key);
    assert.equal(forwarded[key], `${{ inputs.${key} }}`);
  }
});
