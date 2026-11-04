import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  if?: string;
  with?: Record<string, string | boolean>;
};

test("Release Build uses GitHub App for preflight and a dedicated read-only checkout credential", async () => {
  const source = await readFile(".github/workflows/release-app.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<string, { steps: Step[]; outputs?: Record<string, string> }>;
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
  const visibility = prepare.find((step) => step.name === "Resolve release source visibility");
  assert.equal(visibility?.id, "source_visibility");
  assert.equal(visibility?.env?.GH_TOKEN, "${{ steps.app_read.outputs.token }}");
  assert.equal(
    workflow.jobs.prepare?.outputs?.is_private,
    "${{ steps.source_visibility.outputs.is_private }}"
  );

  const buildSteps = workflow.jobs.build?.steps ?? [];
  const buildPrivate = buildSteps.find((step) => step.name === "Checkout private source");
  const buildPublic = buildSteps.find((step) => step.name === "Checkout public source");
  const requirePrivate = buildSteps.find(
    (step) => step.name === "Require dedicated private release checkout credential"
  );
  assert.equal(requirePrivate?.if, "needs.prepare.outputs.is_private == 'true'");
  assert.equal(
    requirePrivate?.env?.AW_CHECKOUT_TOKEN,
    "${{ secrets.AW_CHECKOUT_TOKEN }}"
  );
  assert.equal(buildPrivate?.if, "needs.prepare.outputs.is_private == 'true'");
  assert.equal(buildPublic?.if, "needs.prepare.outputs.is_private == 'false'");
  assert.equal(buildPrivate?.with?.token, "${{ secrets.AW_CHECKOUT_TOKEN }}");
  assert.equal(buildPublic?.with?.token, "${{ github.token }}");
  assert.equal(buildPrivate?.with?.["persist-credentials"], false);
  assert.equal(buildPublic?.with?.["persist-credentials"], false);
  assert.equal(
    buildSteps.some((step) => step.name === "Mint release package source read token"),
    false
  );

  const pkg = workflow.jobs.package?.steps ?? [];
  const scope = pkg.find((step) => step.name === "Resolve release package source scope");
  const mint = pkg.find((step) => step.name === "Mint release package source read token");
  const checkout = pkg.find((step) => step.name === "Checkout release source");
  assert.equal(scope?.id, "package_scope");
  assert.equal(scope?.env?.TARGET_REPOSITORY, "${{ needs.prepare.outputs.source_repository }}");
  assert.equal(mint?.id, "package_read_app");
  assert.equal(mint?.with?.repositories, "${{ steps.package_scope.outputs.repository_name }}");
  assert.deepEqual(
    Object.entries(mint?.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-contents", "read"]]
  );
  assert.equal(checkout?.with?.token, "${{ steps.package_read_app.outputs.token }}");
  assert.equal(checkout?.with?.["persist-credentials"], false);
  const pkgText = source.split("\n  package:\n")[1] ?? "";
  assert.doesNotMatch(pkgText, /secrets\.AW_CHECKOUT_TOKEN/);
});
