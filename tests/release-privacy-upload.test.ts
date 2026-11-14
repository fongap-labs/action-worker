import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type ReleaseStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type ReleaseWorkflow = {
  jobs: Record<string, { steps?: ReleaseStep[]; permissions?: Record<string, string> }>;
};

test("first release artifact upload is blocked behind a trusted privacy scanner", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release-app.yml", "utf8")
  ) as ReleaseWorkflow;
  const build = workflow.jobs.build;
  assert.ok(build);
  const steps = build.steps ?? [];
  const find = (name: string): number => steps.findIndex((s) => s.name === name);
  const accept = find("Run product acceptance (Node)");
  const checkout = find("Checkout trusted release privacy scanner");
  const python = find("Setup release privacy scanner Python");
  const scan = find("Enforce build asset privacy before first upload");
  const upload = find("Upload build assets");
  assert.ok(accept >= 0 && checkout > accept && python > checkout);
  assert.ok(scan > python && upload > scan);
  assert.match(steps[checkout]?.uses ?? "", /^actions\/checkout@[a-f0-9]{40}$/);
  assert.equal(steps[checkout]?.with?.ref, "${{ github.sha }}");
  assert.equal(steps[checkout]?.with?.["persist-credentials"], false);
  assert.equal(steps[python]?.with?.["python-version"], "3.12");
  assert.match(steps[scan]?.run ?? "", /python .*artifact-privacy-scan\.py/);
  assert.match(steps[scan]?.run ?? "", /policies\/security\.json/);
  assert.match(steps[scan]?.run ?? "", /RUNNER_TEMP\/release-build/);
  assert.doesNotMatch(steps[scan]?.run ?? "", /continue-on-error|\|\| true/);
  assert.notEqual(build.permissions?.["id-token"], "write");
  assert.notEqual(build.permissions?.attestations, "write");
});

test("final release package privacy gate remains in place", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release-app.yml", "utf8")
  ) as ReleaseWorkflow;
  const steps = workflow.jobs.package?.steps ?? [];
  const scan = steps.findIndex((s) => s.name === "Enforce release artifact privacy gate");
  const upload = steps.findIndex((s) => s.name === "Upload governed release artifact");
  assert.ok(scan >= 0 && upload > scan);
});
