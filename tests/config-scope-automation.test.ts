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
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "schedule"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(workflow.on.push.paths.includes("policies/repository-access.json"));
  assert.ok(workflow.on.push.paths.includes("policies/task-secrets.json"));
  assert.ok(workflow.on.push.paths.includes("policies/deploy-secrets.json"));
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["audit"]);

  const job = workflow.jobs.audit;
  assert.ok(job);
  assert.deepEqual(job.environment, { name: "admin-ops", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.match(String(job.if), /github.repository == 'fongap-labs\/action-worker'/);
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
  assert.doesNotMatch(serialized, /upload-artifact|download-artifact|gh secret set/);
});
