import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;
};

type WorkflowJob = {
  needs?: string[];
  permissions?: Record<string, string>;
  strategy?: { matrix?: string };
  steps?: WorkflowStep[];
};

type ReleaseWorkflow = { jobs: Record<string, WorkflowJob> };

test("untrusted release builds cannot mint OIDC tokens or write attestations", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release-app.yml", "utf8")
  ) as ReleaseWorkflow;
  const build = workflow.jobs.build;
  assert.ok(build);
  assert.equal(build.permissions?.contents, "read");
  assert.notEqual(build.permissions?.["id-token"], "write");
  assert.notEqual(build.permissions?.attestations, "write");
  assert.equal(
    build.steps?.some((step) => step.uses?.startsWith("actions/attest-build-provenance@")),
    false
  );
  assert.equal(
    build.steps?.some((step) => step.name === "Upload build assets"),
    true
  );
});

test("dedicated attestation job only downloads artifacts and produces provenance", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release-app.yml", "utf8")
  ) as ReleaseWorkflow;
  const attest = workflow.jobs.attest;
  assert.ok(attest);
  assert.deepEqual(attest.needs, ["prepare", "build"]);
  assert.equal(attest.strategy?.matrix, "${{ fromJSON(needs.prepare.outputs.matrix) }}");
  assert.equal(attest.permissions?.contents, "read");
  assert.equal(attest.permissions?.["id-token"], "write");
  assert.equal(attest.permissions?.attestations, "write");
  assert.deepEqual(
    attest.steps?.map((step) => step.name),
    ["Download build artifact for attestation", "Attest build provenance"]
  );
  assert.equal(attest.steps?.[0]?.with?.name, "release-build-${{ matrix.id }}");
  assert.equal(
    attest.steps?.[1]?.with?.["subject-path"],
    "${{ runner.temp }}/release-build/${{ matrix.attest_asset }}"
  );
  assert.equal(
    attest.steps?.every(
      (step) =>
        !step.run &&
        !step.uses?.startsWith("actions/checkout@") &&
        step.if === "${{ matrix.attest_asset != '' }}"
    ),
    true
  );
  assert.deepEqual(workflow.jobs.package?.needs, ["prepare", "build", "attest"]);
});
