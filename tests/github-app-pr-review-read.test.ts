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

test("PR AI Review preflight reads via a policy-scoped token, not a personal PAT", async () => {
  const workflow = parse(await readFile(".github/workflows/handle-pr-review.yml", "utf8")) as {
    permissions: Record<string, string>;
    jobs: { prepare: { steps: Step[] }; review: { steps: Step[] } };
  };
  const prepare = (name: string) => {
    const step = workflow.jobs.prepare.steps.find((item) => item.name === name);
    assert.ok(step, name);
    return step;
  };

  assert.equal(workflow.permissions.statuses, "read");
  const scope = prepare("Resolve PR review API scope");
  assert.equal(scope.id, "api_scope");
  assert.equal(scope.env?.TARGET_REPOSITORY, "${{ steps.payload.outputs.repository }}");
  const mint = prepare("Mint cross-repository PR review read token");
  assert.equal(mint.if, undefined);
  assert.equal(mint.uses, "./.github/actions/mint-app-token");
  assert.equal(
    mint.with?.repositories,
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.event.repository.name || format('{0},{1}', github.event.repository.name, steps.api_scope.outputs.repository_name) }}"
  );
  assert.deepEqual(
    Object.entries(mint.with ?? {})
      .filter(([key]) => key.startsWith("permission-"))
      .map(([key, value]) => [key, value]),
    [
      ["permission-contents", "read"],
      ["permission-actions", "read"],
      ["permission-pull-requests", "read"],
      ["permission-statuses", "read"],
    ]
  );
  const selected =
    "${{ steps.api_scope.outputs.is_control_repository == 'true' && github.token || steps.app_read.outputs.token }}";
  for (const name of [
    "Validate control credential",
    "Fetch PR facts",
    "Confirm the gate passed for the requested head",
  ]) {
    assert.equal(prepare(name).env?.GH_TOKEN, selected);
  }
  assert.equal(prepare("Validate control credential").env?.AW_STATUS_API_TOKEN, undefined);
  assert.equal(
    prepare("Confirm the gate passed for the requested head").env?.AW_STATUS_API_TOKEN,
    selected
  );
});

test("final review re-check mints a fresh read token after long-running AI work", async () => {
  const workflow = parse(await readFile(".github/workflows/handle-pr-review.yml", "utf8")) as {
    jobs: { review: { steps: Step[] } };
  };
  const steps = workflow.jobs.review.steps;
  const scope = steps.find((step) => step.name === "Resolve final PR review API scope");
  assert.equal(scope?.id, "review_scope");
  const mint = steps.find((step) => step.name === "Mint final PR review read token");
  assert.equal(mint?.id, "review_app");
  assert.equal(mint?.with?.["permission-statuses"], "read");
  assert.equal(mint?.with?.["permission-pull-requests"], "read");
  const recheck = steps.find((step) => step.name === "Recheck review target");
  assert.equal(
    recheck?.env?.GH_TOKEN,
    "${{ steps.review_scope.outputs.is_control_repository == 'true' && github.token || steps.review_app.outputs.token }}"
  );
  assert.equal(
    recheck?.env?.AW_STATUS_API_TOKEN,
    "${{ steps.review_scope.outputs.is_control_repository == 'true' && github.token || steps.review_app.outputs.token }}"
  );
  assert.ok(steps.indexOf(mint!) < steps.indexOf(recheck!));

  const script = await readFile("scripts/check-review-target.ts", "utf8");
  assert.match(
    script,
    /getGithubJson\([\s\S]*?repos\/\$\{repository\}\/commits\/\$\{headSha\}\/status`,\s*statusToken\)/
  );
  assert.match(script, /hasValidStatusAttestation/);
});

test("review checkout, evidence and publication do not use personal control tokens", async () => {
  const source = await readFile(".github/workflows/handle-pr-review.yml", "utf8");
  const workflow = parse(source) as {
    jobs: { review: { steps: Step[] } };
  };
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  const steps = workflow.jobs.review.steps;
  const find = (name: string) => steps.find((step) => step.name === name);
  assert.equal(find("Checkout target PR")?.with?.token, "${{ steps.evidence_app.outputs.token }}");
  assert.equal(
    find("Collect CI evidence")?.env?.AW_CONTROL_TOKEN,
    "${{ steps.evidence_app.outputs.token }}"
  );
  assert.equal(
    steps.find((step) => step.name === "Publish PR review" && step.env?.AW_CONTROL_TOKEN)?.env
      ?.AW_CONTROL_TOKEN,
    "${{ steps.review_app.outputs.token }}"
  );
});
