import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { shouldRunMainRefCi } from "../scripts/should-run-central-ci.ts";
import { attestFixtureResponseForPath } from "./attested-status-fixtures.ts";

const control = "fongap-labs/action-worker";
const repository = "fongap-labs/delta";
const sha = "a".repeat(40);
const controllerSha = "b".repeat(40);
const oldControllerSha = "c".repeat(40);
const statusPath = `repos/${repository}/commits/${sha}/status`;
const runPath = `repos/${control}/actions/runs/1234`;
const runUrl = `https://github.com/${control}/actions/runs/1234`;

function signed(state: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return attestFixtureResponseForPath(statusPath, {
    statuses: [
      {
        context: "CI Evidence",
        state,
        description: "Central CI failed",
        target_url: runUrl,
        created_at: now,
        updated_at: now,
        ...overrides,
      },
    ],
  });
}

function controlRun(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: 1234,
    repository: { full_name: control },
    path: ".github/workflows/central-ci-dispatch.yml",
    event: "repository_dispatch",
    head_branch: "main",
    head_sha: controllerSha,
    status: "completed",
    conclusion: "failure",
    run_started_at: now,
    updated_at: now,
    ...overrides,
  };
}

function readerFor(run: unknown) {
  const requested: string[] = [];
  return {
    requested,
    async get(path: string): Promise<unknown> {
      assert.equal(path, runPath);
      requested.push(path);
      return run;
    },
  };
}

function shouldRun(
  response: unknown,
  reader: ReturnType<typeof readerFor>,
  controlHeadSha = controllerSha
) {
  return shouldRunMainRefCi(response, reader, control, repository, sha, controlHeadSha);
}

test("missing or forged status cannot suppress the mandatory main CI", async () => {
  const reader = readerFor(controlRun());
  assert.equal(await shouldRun({ statuses: [] }, reader), true);
  const forged = {
    statuses: [
      {
        context: "CI Evidence",
        state: "failure",
        description: "Central CI failed",
        target_url: runUrl,
      },
    ],
  };
  assert.equal(await shouldRun(forged, reader), true);
  assert.deepEqual(reader.requested, []);
});

test("valid complete CI success is reused, without treating a URL alone as proof", async () => {
  const status = signed("success");
  const unrelated = controlRun({
    conclusion: "success",
    path: ".github/workflows/handle-task-dispatch.yml",
  });
  const complete = readerFor(unrelated);
  assert.equal(await shouldRun(status, complete), true);
  const past = new Date(Date.now() - 50_000).toISOString();
  const validRun = controlRun({ conclusion: "success", run_started_at: past });
  const verified = readerFor(validRun);
  assert.equal(await shouldRun(status, verified), false);
});

test("active signed CI lease suppresses duplicate expensive main builds", async () => {
  const reader = readerFor(controlRun({ status: "in_progress", conclusion: null }));
  assert.equal(await shouldRun(signed("pending"), reader), false);
  assert.deepEqual(reader.requested, [runPath]);
});

test("failed signed CI lease stays blocked on the same controller revision", async () => {
  const expired = new Date(Date.now() - 5 * 60_000).toISOString();
  const reader = readerFor(controlRun());
  assert.equal(await shouldRun(signed("pending", { updated_at: expired }), reader), false);
  assert.ok(reader.requested.length >= 2);
});

test("signed nonretryable failures and errors remain failed, not green or rerun", async () => {
  const reader = readerFor(controlRun());
  assert.equal(await shouldRun(signed("failure"), reader), false);
  assert.equal(await shouldRun(signed("error"), reader), false);
});

test("a failure on an old control revision can be reverified after controller changes", async () => {
  const reader = readerFor(controlRun({ head_sha: oldControllerSha }));
  assert.equal(await shouldRun(signed("failure"), reader), true);
  const expired = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.equal(await shouldRun(signed("pending", { updated_at: expired }), reader), true);
});

test("cancelled old leases expire and allow evidence recovery", async () => {
  const expired = new Date(Date.now() - 5 * 60_000).toISOString();
  const reader = readerFor(controlRun({ status: "completed", conclusion: "cancelled" }));
  assert.equal(await shouldRun(signed("pending", { updated_at: expired }), reader), true);
});

test("branch CI skip does not bypass any required gate or publish synthetic success", () => {
  const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
  assert.match(workflow, /node scripts\/should-run-central-ci\.ts/);
  assert.match(workflow, /should_run=\$should_run/);
  assert.match(workflow, /needs\.prepare\.outputs\.should_run != 'false'/);
  assert.match(workflow, /name: Publish Central CI/);
});
