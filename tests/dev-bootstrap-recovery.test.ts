import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mainWriteGuardWorkflowPaths } from "../scripts/ci-evidence.ts";
import {
  bootstrapIntegrationId,
  temporaryDevGuardName,
} from "../scripts/create-protected-dev.ts";
import { recoverInterruptedDevBootstrap } from "../scripts/dev-bootstrap-recovery.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/example";
const control = "fongap-labs/action-worker";
const sha = "a".repeat(40);
const prefix = `repos/${repository}`;
const runPath = `repos/${control}/actions/runs/42`;
const listPath = `${prefix}/rulesets?includes_parents=false&per_page=100`;
const closedPath = `${prefix}/rulesets/12?includes_parents=false`;
const guardPath = `${prefix}/rulesets/13?includes_parents=false`;
const now = Date.parse("2026-11-25T12:00:00Z");
const policy = JSON.parse(readFileSync("policies/rulesets.json", "utf8")) as {
  rulesets: Array<Record<string, unknown>>;
};
const closed = policy.rulesets.find((rule) => rule.name === "Protect Dev Branch")!;
const receipt = {
  context: "Dev Bootstrap Authorization",
  state: "success",
  description: `init-v1=${sha}`,
  target_url: `https://github.com/${control}/actions/runs/42`,
  created_at: "2026-11-25T11:00:02Z",
};
const mainReceipt = {
  context: "Main Write Guard",
  state: "success",
  description: "Trusted main",
  target_url: `https://github.com/${control}/actions/runs/41`,
  created_at: "2026-11-25T10:00:00Z",
};

function fixture() {
  const statuses = attestFixtureStatuses({ statuses: [receipt, mainReceipt] }, repository, sha);
  const guard = {
    name: temporaryDevGuardName,
    target: "branch",
    enforcement: "active",
    conditions: closed.conditions,
    bypass_actors: [
      { actor_id: bootstrapIntegrationId(), actor_type: "Integration", bypass_mode: "always" },
    ],
    rules: [{ type: "creation" }],
    created_at: "2026-11-25T11:00:04Z",
    updated_at: "2026-11-25T11:00:04Z",
  };
  const actor = { id: 9, login: "operator", type: "User" };
  const steps = [
    ...[
      "Check source and display authorization scope",
      "Verify approval before issuing initialization receipt",
      "Mint initialization receipt token",
      "Mint repository-scoped initialization ref token",
    ].map((name) => ({ name, conclusion: "success" })),
    {
      name: "Record approved authorization and initialize dev",
      conclusion: "failure",
      started_at: "2026-11-25T11:00:00Z",
      completed_at: "2026-11-25T11:00:10Z",
    },
  ];
  const responses = new Map<string, unknown>([
    [
      runPath,
      {
        id: 42,
        repository: { full_name: control },
        head_branch: "main",
        path: ".github/workflows/authorize-branch-transfer.yml",
        event: "workflow_dispatch",
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        actor,
        triggering_actor: actor,
        run_started_at: "2026-11-25T10:59:00Z",
        updated_at: "2026-11-25T11:01:00Z",
      },
    ],
    [
      `${runPath}/attempts/1/jobs?per_page=100`,
      {
        total_count: 1,
        jobs: [
          {
            name: "Check and authorize managed branch operation",
            run_attempt: 1,
            conclusion: "failure",
            steps,
          },
        ],
      },
    ],
    [prefix, { full_name: repository, private: false, default_branch: "main" }],
    [listPath, [{ ...closed, id: 12 }, { ...guard, id: 13 }]],
    [closedPath, closed],
    [guardPath, guard],
    [`${prefix}/branches/main`, { commit: { sha } }],
    [`${prefix}/branches/dev`, { commit: { sha } }],
    [`${prefix}/issues?state=open&per_page=100&page=1`, []],
    [`${prefix}/commits/${sha}/status`, statuses],
    [
      `repos/${control}/actions/runs/41`,
      {
        id: 41,
        repository: { full_name: control },
        head_branch: "main",
        path: mainWriteGuardWorkflowPaths[0],
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-11-25T09:59:00Z",
        updated_at: "2026-11-25T10:01:00Z",
      },
    ],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(responses.has(path), path);
      return responses.get(path);
    },
  };
  const deletions: number[] = [];
  const remove = async (id: number) => {
    assert.equal(id, 13);
    deletions.push(id);
    responses.set(listPath, [{ ...closed, id: 12 }]);
    responses.delete(guardPath);
  };
  return {
    responses,
    guard,
    steps,
    deletions,
    statuses,
    recover: (input: unknown = statuses) =>
      recoverInterruptedDevBootstrap(reader, repository, sha, input, control, remove, now),
  };
}

test("a failed publisher can only recover its exact redundant guard after independent verification", async () => {
  const f = fixture();
  assert.equal(await f.recover(), `init-v1=${sha}`);
  assert.deepEqual(f.deletions, [13]);
  assert.deepEqual(f.responses.get(closedPath), closed);
});

test("unsigned approval, changed guard and failed verification do not grant recovery", async () => {
  const unsigned = fixture();
  assert.equal(await unsigned.recover({ statuses: [receipt] }), undefined);
  assert.deepEqual(unsigned.deletions, []);
  const changed = fixture();
  changed.responses.set(guardPath, { ...changed.guard, bypass_actors: [] });
  assert.equal(await changed.recover(), undefined);
  assert.deepEqual(changed.deletions, []);
  const failed = fixture();
  failed.steps[1]!.conclusion = "failure";
  assert.equal(await failed.recover(), undefined);
  assert.deepEqual(failed.deletions, []);
  const wrongSha = fixture();
  wrongSha.responses.set(`${prefix}/branches/dev`, { commit: { sha: "b".repeat(40) } });
  await assert.rejects(wrongSha.recover(), /branch identity changed/);
  assert.deepEqual(wrongSha.deletions, []);
});
