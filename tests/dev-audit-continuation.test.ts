import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  completedDevMergePublisher,
  matchesCompletedDevMerge,
} from "../scripts/audit-dev-writes.ts";
import { engineeringLineViolation } from "../scripts/validate-engineering-language.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const control = "fongap-labs/action-worker";
const repository = "fongap-labs/example";
const sha = "a".repeat(40);
const mergeSha = "b".repeat(40);
const url = `https://github.com/${control}/actions/runs/42`;
const run = {
  id: 42,
  repository: { full_name: control },
  path: ".github/workflows/handle-pr-dispatch.yml",
  head_branch: "main",
  event: "repository_dispatch",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
};

test("only a trusted completed PR publisher can select a dev audit", async () => {
  assert.equal(await completedDevMergePublisher({ get: async () => run }, control, 42), url);
  for (const invalid of [
    { ...run, status: "in_progress" },
    { ...run, conclusion: "failure" },
    { ...run, head_branch: "dev" },
    { ...run, repository: { full_name: repository } },
    { ...run, path: ".github/workflows/intake.yml" },
    { ...run, event: "pull_request" },
    { ...run, run_attempt: 2 },
  ]) {
    await assert.rejects(completedDevMergePublisher({ get: async () => invalid }, control, 42));
  }
  await assert.rejects(completedDevMergePublisher({ get: async () => run }, control, 0));
});

test("only the current SHA signed receipt from that exact run wakes the audit", () => {
  const receipt = {
    context: "Dev Merge Receipt",
    state: "success",
    description: `merge-v1=${mergeSha}`,
    target_url: url,
  };
  const signed = attestFixtureStatuses({ statuses: [receipt] }, repository, sha);
  assert.equal(matchesCompletedDevMerge(signed, repository, sha, url), true);
  assert.equal(matchesCompletedDevMerge(signed, repository, mergeSha, url), false);
  assert.equal(matchesCompletedDevMerge(signed, repository, sha, url + "1"), false);
  assert.equal(matchesCompletedDevMerge({ statuses: [receipt] }, repository, sha, url), false);
  const failed = attestFixtureStatuses(
    { statuses: [{ ...receipt, state: "failure" }] },
    repository,
    sha
  );
  assert.equal(matchesCompletedDevMerge(failed, repository, sha, url), false);
});

test("completion only runs the existing dev audit, not the rest of intake", () => {
  const path = ".github/workflows/intake.yml";
  const intake = parse(readFileSync(path, "utf8"));
  const handler = parse(readFileSync(".github/workflows/handle-pr-dispatch.yml", "utf8"));
  assert.deepEqual(intake.on.workflow_run.workflows, [handler.name]);
  assert.deepEqual(intake.on.workflow_run.branches, ["main"]);
  const reference = `workflows: ["${handler.name}"]`;
  assert.equal(engineeringLineViolation(path, reference), null);
  assert.notEqual(engineeringLineViolation(".github/workflows/other.yml", reference), null);
  for (const name of [
    "pull-requests",
    "main-ci",
    "main-writes",
    "task-sources",
    "task-schedules",
    "deploy-schedules",
    "skill-admissions",
  ]) {
    assert.match(intake.jobs[name].if, /github\.event_name != 'workflow_run'/);
  }
  const audit = intake.jobs["dev-writes"];
  assert.match(audit.if, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(audit.if, /github\.event\.workflow_run\.head_repository\.full_name/);
  assert.match(audit.if, /github\.event\.workflow_run\.event == 'repository_dispatch'/);
  assert.ok(intake.on.schedule.length);
});
