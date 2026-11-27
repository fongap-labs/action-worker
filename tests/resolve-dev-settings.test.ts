import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { resolveDevSettings } from "../scripts/resolve-dev-settings.ts";
import { engineeringLineViolation } from "../scripts/validate-engineering-language.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const control = "fongap-labs/action-worker";
const alpha = "fongap-labs/alpha";
const beta = "fongap-labs/beta";
const sha = "a".repeat(40);
const runId = 42;
const runPath = `repos/${control}/actions/runs/${runId}`;
const target = `https://github.com/${control}/actions/runs/${runId}`;
const policy = { [control]: ["pr"], [alpha]: ["pr"], [beta]: ["pr"] };

test("settings continuation selects current signed guards from the completed audit", async () => {
  const run = {
    id: runId,
    repository: { full_name: control },
    path: ".github/workflows/intake.yml",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const status = {
    context: "Dev Write Guard",
    state: "success",
    target_url: target,
    description: `init-v1=${sha}`,
  };
  const responses = new Map<string, unknown>([
    [runPath, run],
    [`repos/${control}/branches/dev`, { commit: { sha } }],
    [`repos/${control}/commits/${sha}/status`, { statuses: [] }],
    [`repos/${alpha}/branches/dev`, { commit: { sha } }],
    [`repos/${beta}/branches/dev`, { commit: { sha } }],
    [
      `repos/${alpha}/commits/${sha}/status`,
      attestFixtureStatuses({ statuses: [status] }, alpha, sha),
    ],
    [`repos/${beta}/commits/${sha}/status`, { statuses: [status] }],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(responses.has(path), path);
      return responses.get(path);
    },
  };
  const resolve = () => resolveDevSettings(reader, policy, control, runId);
  assert.deepEqual(await resolve(), [alpha]);
  responses.set(
    `repos/${control}/commits/${sha}/status`,
    attestFixtureStatuses({ statuses: [status] }, control, sha)
  );
  assert.deepEqual(await resolve(), [control, alpha].sort());
  responses.set(`repos/${control}/commits/${sha}/status`, { statuses: [] });
  responses.set(
    `repos/${alpha}/commits/${sha}/status`,
    attestFixtureStatuses({ statuses: [{ ...status, target_url: target + "1" }] }, alpha, sha)
  );
  assert.deepEqual(await resolve(), []);
  responses.set(runPath, { ...run, conclusion: "failure" });
  await assert.rejects(resolve(), /trusted completed intake/);
  responses.set(runPath, { ...run, head_branch: "dev" });
  await assert.rejects(resolve(), /trusted completed intake/);
});

test("audit continuation reuses settings workflow and never expands repository permissions", () => {
  const workflow = readFileSync(".github/workflows/apply-repository-settings.yml", "utf8");
  assert.match(workflow, /workflows: \["自动 · 总控调度"\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /scripts\/resolve-dev-settings\.ts/);
  assert.match(workflow, /steps\.dev_settings\.outputs\.repositories/);
  assert.match(workflow, /permission-statuses: read/);
  assert.doesNotMatch(
    workflow,
    /permission-contents: write[^\n]*\n[^\n]*permission-statuses: write/
  );
});

test("only the exact existing display-name reference is accepted by the language gate", () => {
  const path = ".github/workflows/apply-repository-settings.yml";
  const intake = parse(readFileSync(".github/workflows/intake.yml", "utf8"));
  const settings = parse(readFileSync(path, "utf8"));
  assert.deepEqual(settings.on.workflow_run.workflows, [intake.name]);
  const reference = `workflows: ["${intake.name}"]`;
  assert.equal(engineeringLineViolation(path, reference), null);
  assert.notEqual(engineeringLineViolation(".github/workflows/other.yml", reference), null);
  assert.notEqual(engineeringLineViolation(path, `${reference} # ${intake.name}`), null);
  assert.notEqual(engineeringLineViolation(path, `run: echo "${intake.name}"`), null);
});

test("changed dev protection wakes the existing intake, while unchanged settings do not", () => {
  const workflow = readFileSync(".github/workflows/apply-repository-settings.yml", "utf8");
  const settings = parse(workflow);
  const steps = settings.jobs["apply-managed"].steps;
  const mint = steps.find((step: { id?: string }) => step.id === "wake_app");
  const wake = steps.find(
    (step: { name?: string }) => step.name === "Wake PR intake after dev protection changes"
  );
  assert.equal(mint.if, "steps.applied.outputs.dev_protection_changed == 'true'");
  assert.equal(wake.if, mint.if);
  assert.equal(mint.with.repositories, "${{ github.event.repository.name }}");
  assert.equal(mint.with["permission-contents"], "write");
  assert.match(wake.run, /event_type:"run-intake"/);
  const intake = parse(readFileSync(".github/workflows/intake.yml", "utf8"));
  assert.equal(intake.jobs["pull-requests"].if, "github.event_name != 'workflow_run'");
});

test("the controller uses the same single settings writer as every managed repository", () => {
  const workflow = readFileSync(".github/workflows/apply-repository-settings.yml", "utf8");
  assert.equal(workflow.match(/node scripts\/apply-repository-settings\.ts/g)?.length, 1);
  const settings = parse(workflow);
  const steps = settings.jobs["apply-managed"].steps;
  const writer = steps.find((step: { id?: string }) => step.id === "applied");
  assert.equal(writer.env.AW_STATUS_KEYRING, "${{ secrets.AW_STATUS_KEYRING }}");
  assert.equal(writer.env.TARGET_REPOSITORY, "${{ matrix.repository }}");
  assert.match(
    settings.jobs["resolve-managed"].outputs.repositories,
    /steps\.policy\.outputs\.repositories/
  );
});
