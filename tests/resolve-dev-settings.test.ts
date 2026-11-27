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
