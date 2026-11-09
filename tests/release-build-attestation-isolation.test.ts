import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  "continue-on-error"?: boolean;
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
  assert.equal(attest.steps?.[1]?.with?.["subject-path"], "${{ runner.temp }}/release-build/*");
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

test("declared acceptance runs on the unprivileged build runner before artifact upload", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release-app.yml", "utf8")
  ) as ReleaseWorkflow;
  const build = workflow.jobs.build;
  assert.ok(build);
  const steps = build.steps ?? [];
  const upload = steps.findIndex((step) => step.name === "Upload build assets");
  const powershell = steps.findIndex((step) => step.name === "Run product acceptance (PowerShell)");
  const node = steps.findIndex((step) => step.name === "Run product acceptance (Node)");
  assert.ok(powershell >= 0 && node > powershell && upload > node);
  assert.match(steps[powershell]?.if ?? "", /matrix.acceptance_script/);
  assert.match(steps[node]?.if ?? "", /matrix.acceptance_script/);
  assert.notEqual(build.permissions?.["id-token"], "write");
  assert.notEqual(build.permissions?.attestations, "write");
});

test("SBOM release packaging retries transient tool downloads but never bypasses attestation", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release-app.yml", "utf8")
  ) as ReleaseWorkflow;
  const steps = workflow.jobs.package?.steps ?? [];
  const attempts = steps.filter((step) => step.id?.startsWith("sbom_attempt_"));
  assert.deepEqual(
    attempts.map((step) => step.id),
    ["sbom_attempt_1", "sbom_attempt_2", "sbom_attempt_3"]
  );
  for (const attempt of attempts) {
    assert.equal(attempt.uses, "anchore/sbom-action@66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c");
    assert.equal(attempt.with?.["syft-version"], "v1.54.0");
    assert.equal(attempt.with?.format, "cyclonedx-json");
    assert.equal(attempt.with?.path, "source");
    assert.equal(
      attempt.with?.["output-file"],
      "${{ runner.temp }}/release-package/${{ needs.prepare.outputs.sbom_asset }}"
    );
  }
  assert.equal(attempts[0]?.["continue-on-error"], true);
  assert.equal(attempts[1]?.["continue-on-error"], true);
  assert.equal(attempts[2]?.["continue-on-error"], undefined);
  assert.match(attempts[1]?.if ?? "", /steps\.sbom_attempt_1\.outcome == 'failure'/);
  assert.match(attempts[2]?.if ?? "", /steps\.sbom_attempt_1\.outcome == 'failure'/);
  assert.match(attempts[2]?.if ?? "", /steps\.sbom_attempt_2\.outcome == 'failure'/);
  const validation = steps.findIndex((step) => step.name === "Verify generated CycloneDX SBOM");
  const manifest = steps.findIndex((step) => step.name === "Build manifest and provenance");
  const finalAttempt = attempts[2];
  assert.ok(finalAttempt);
  assert.ok(validation > steps.indexOf(finalAttempt) && manifest > validation);
  assert.match(steps[validation]?.run ?? "", /test -s "\$SBOM_PATH"/);
  assert.match(steps[validation]?.run ?? "", /\.bomFormat == "CycloneDX"/);
});
