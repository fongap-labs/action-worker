import assert from "node:assert/strict";
import { test } from "node:test";
import { assertManualBranchAuthorization } from "../scripts/branch-transfer-approval.ts";
import { branchAuthorizationWorkflow } from "../scripts/dev-bootstrap-authorization.ts";

const control = "org/control";
const repository = "org/product";
const actor = { id: 9, login: "operator", type: "User" };
const runId = 42;

function fixture() {
  const run = {
    id: runId,
    run_attempt: 1,
    repository: { full_name: control },
    head_branch: "main",
    path: branchAuthorizationWorkflow,
    event: "workflow_dispatch",
    status: "in_progress",
    actor,
    triggering_actor: actor,
  };
  const permission = { permission: "admin", user: actor };
  const runPath = `repos/${control}/actions/runs/${runId}`;
  const controlPath = `repos/${control}/collaborators/${actor.login}/permission`;
  const targetPath = `repos/${repository}/collaborators/${actor.login}/permission`;
  const entries = new Map<string, unknown>([
    [runPath, run],
    [controlPath, permission],
    [targetPath, permission],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(entries.has(path), path);
      return entries.get(path);
    },
  };
  const verify = () => assertManualBranchAuthorization(reader, control, repository, runId, 1);
  return { reader, verify, entries, run, runPath, controlPath, targetPath, permission };
}

test("fresh manual administrator dispatch works without a dedicated Environment lookup", async () => {
  await fixture().verify();
});

test("bots, reruns, scheduled events and other workflows cannot authorize branch operations", async () => {
  const world = fixture();
  for (const change of [
    { actor: { ...actor, type: "Bot" } },
    { triggering_actor: { ...actor, id: 10 } },
    { run_attempt: 2 },
    { event: "repository_dispatch" },
    { head_branch: "dev" },
    { path: ".github/workflows/intake.yml" },
    { status: "completed" },
  ]) {
    world.entries.set(world.runPath, { ...world.run, ...change });
    await assert.rejects(world.verify());
  }
  await assert.rejects(
    assertManualBranchAuthorization(world.reader, control, repository, runId, 2),
    /fresh manual run/
  );
});

test("both current repository administrator grants must match the exact user", async () => {
  for (const field of ["controlPath", "targetPath"] as const) {
    const world = fixture();
    for (const permission of [
      { ...world.permission, permission: "write" },
      { ...world.permission, user: { ...actor, id: 10 } },
      { ...world.permission, user: { ...actor, type: "Bot" } },
    ]) {
      world.entries.set(world[field], permission);
      await assert.rejects(world.verify(), /current administrator access/);
    }
  }
});
