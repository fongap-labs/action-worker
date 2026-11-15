import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { requireVerifiedCiEvidence } from "../scripts/ci-evidence.ts";
import { assertExpectedRepository, parseDeployRequest } from "../scripts/validate-deploy-source.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("deploy dispatch is exact and repository binding is executor-owned", () => {
  const request = {
    schema_version: "1",
    request_id: "deploy-123",
    source_repository: "fongap-labs/example",
    source_sha: sha,
  };
  const parsed = parseDeployRequest(request);
  assert.deepEqual(parsed, request);
  assert.doesNotThrow(() => assertExpectedRepository(parsed, ""));
  assert.doesNotThrow(() => assertExpectedRepository(parsed, "fongap-labs/example"));
  assert.throws(() => assertExpectedRepository(parsed, "fongap-labs/other"));
  assert.throws(() => parseDeployRequest({ ...request, extra: true }));
});

test("deploy evidence must be verified against a successful Action Worker CI run", async () => {
  const deploySha = "b".repeat(40);
  const statusPath = `repos/fongap-labs/example/commits/${deploySha}/status`;
  const status = {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        target_url: "https://github.com/fongap-labs/action-worker/actions/runs/123",
        created_at: "2026-10-02T13:11:43Z",
      },
    ],
  };
  const run = {
    id: 123,
    repository: { full_name: "fongap-labs/action-worker" },
    path: ".github/workflows/central-ci-dispatch.yml",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-10-02T13:10:15Z",
    updated_at: "2026-10-02T13:11:57Z",
  };
  const readerFor = (payload: unknown, runValue: unknown) => ({
    get: async (path: string) =>
      path === statusPath
        ? attestFixtureStatuses(payload, "fongap-labs/example", deploySha)
        : runValue,
  });

  await requireVerifiedCiEvidence(readerFor(status, run), "fongap-labs/example", deploySha);
  for (const [payload, runValue] of [
    [{ statuses: [{ ...status.statuses[0], state: "failure" }] }, run],
    [{ statuses: [{ ...status.statuses[0], target_url: "https://example.invalid/run/123" }] }, run],
    [{ statuses: [{ ...status.statuses[0], context: "ci-evidence" }] }, run],
    [status, { ...run, path: ".github/workflows/validate-ci.yml" }],
    [status, { ...run, conclusion: "failure" }],
  ] as const) {
    await assert.rejects(
      requireVerifiedCiEvidence(readerFor(payload, runValue), "fongap-labs/example", deploySha)
    );
  }
});

test("a deploy request may name a product, an environment and a trigger, and nothing else", () => {
  const request = {
    schema_version: "1",
    request_id: "deploy-456",
    source_repository: "fongap-labs/example",
    source_sha: sha,
  };
  for (const extra of [
    { product: "" },
    { product: "alpha" },
    { environment: "" },
    { environment: "staging" },
    { trigger: "manual" },
    { trigger: "push" },
    { trigger: "schedule" },
  ]) {
    assert.doesNotThrow(() => parseDeployRequest({ ...request, ...extra }), JSON.stringify(extra));
  }
  for (const extra of [
    { product: "../alpha" },
    { product: "a/b" },
    { product: 1 },
    { environment: "Production" },
    { environment: "staging/x" },
    { trigger: "hourly" },
    { trigger: 1 },
    { unknown: "x" },
  ]) {
    assert.throws(() => parseDeployRequest({ ...request, ...extra }), JSON.stringify(extra));
  }
});

test("beta manual source selection requires exact SHA and never runs the main CI/audit chain", async () => {
  const workflow = parse(await readFile(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: { prepare: { steps: Array<{ name?: string; if?: string; run?: string }> } };
  };
  const steps = workflow.jobs.prepare.steps;
  const step = (name: string) => {
    const match = steps.find((item) => item.name === name);
    assert.ok(match, `Missing deployment step: ${name}`);
    return match;
  };
  const condition = "${{ !endsWith(github.event.client_payload.environment || inputs.environment || '', '-beta') }}";
  for (const name of [
    "Mint deploy source CI status token",
    "Mint central CI dispatch token",
    "Request central CI for the source",
    "Resolve source audit API scope",
    "Mint source audit status token",
    "Mint source audit issue token",
    "Attest the source main write",
  ]) {
    assert.equal(step(name).if, condition, `${name} must only run for production`);
  }
  assert.match(step("Resolve manual deploy request").run ?? "", /Beta requires an explicit immutable/);
  assert.equal(step("Validate deploy source").if, undefined);
  assert.equal(step("Reject Beta credential routing into production").if, undefined);
});
