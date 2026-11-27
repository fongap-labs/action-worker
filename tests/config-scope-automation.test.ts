import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

test("organization configuration scope audit is automatic and bound to protected admin ops", () => {
  const workflow = parse(readFileSync(".github/workflows/audit-config-scope.yml", "utf8")) as {
    on: { push: { branches: string[]; paths: string[] }; schedule: Array<{ cron: string }> };
    permissions: Record<string, string>;
    jobs: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "schedule", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(workflow.on.push.paths.includes("policies/repository-access.json"));
  assert.ok(workflow.on.push.paths.includes("policies/task-secrets.json"));
  assert.ok(workflow.on.push.paths.includes("policies/deploy-secrets.json"));
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), [
    "audit",
    "discover-proposals",
    "compute-proposals",
    "propose-dependencies",
    "private-proposals",
  ]);

  const job = workflow.jobs.audit;
  assert.ok(job);
  assert.deepEqual(job.environment, { name: "admin-ops", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.match(String(job.if), /github.repository == 'fongap-labs\/action-worker'/);
  assert.match(String(job.if), /github.event_name != 'workflow_dispatch'/);
  const steps = job.steps as Array<{
    name: string;
    env?: Record<string, string>;
    run?: string;
  }>;
  const metadata = steps.find(
    (step) => step.name === "Read configuration metadata using existing protected admin identity"
  );
  assert.equal(metadata?.env?.AW_CONFIG_AUDIT_READ_TOKEN, "${{ secrets.AW_ADMIN_TOKEN }}");
  assert.equal(metadata?.run, "node scripts/config-storage-audit.ts");
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /permission-secrets: write|secrets: write|actions: write/);
  assert.doesNotMatch(serialized, /gh secret set/);
  for (const name of ["audit", "discover-proposals", "private-proposals"]) {
    assert.doesNotMatch(JSON.stringify(workflow.jobs[name]), /upload-artifact|download-artifact/);
  }
});

test("public no-op proposals do not mint target-scoped credentials", () => {
  const workflow = parse(readFileSync(".github/workflows/audit-config-scope.yml", "utf8"));
  const steps = workflow.jobs["propose-dependencies"].steps as Array<{
    id?: string;
    if?: string;
    env?: Record<string, string>;
  }>;
  const plan = steps.find((step) => step.id === "plan");
  assert.equal(plan?.env?.AW_PROPOSAL_READ_TOKEN, "${{ github.token }}");
  for (const id of ["scope", "read", "writer"]) {
    const step = steps.find((item) => item.id === id);
    assert.equal(step?.if, "inputs.confirm && steps.plan.outputs.changed == 'true'");
    assert.ok(step && plan && steps.indexOf(step) > steps.indexOf(plan));
  }
});
