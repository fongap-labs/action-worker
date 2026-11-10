import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { trustedIntakeTarget } from "../scripts/intake-event-scope.ts";

const policy = {
  "fongap-labs/action-worker": ["pr", "task"],
  "fongap-labs/ai-gateway": ["pr", "task", "deploy"],
  "fongap-labs/dsh-plugin": ["pr"],
};

test("known repository wake-up hint is authorized without changing capability grants", () => {
  assert.equal(trustedIntakeTarget(policy, "fongap-labs/dsh-plugin"), "fongap-labs/dsh-plugin");
  assert.equal(trustedIntakeTarget(policy, ""), "");
  assert.equal(trustedIntakeTarget(policy, "fongap-labs/unmanaged"), "");
  assert.equal(trustedIntakeTarget(policy, "other-org/dsh-plugin"), "");
});

test("invalid event repository cannot silently narrow repository-wide reconciliation", () => {
  for (const invalid of ["../other", "fongap-labs/", "dsh-plugin", "fongap-labs/../private"]) {
    assert.throws(() => trustedIntakeTarget(policy, invalid), /owner\/repository/);
  }
});

test("all relevant intake jobs share one validated repository hint, never cache CI evidence", async () => {
  const workflow = parse(await readFile(".github/workflows/intake.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; env?: Record<string, string> }> }>;
  };
  const expression =
    "${{ github.event_name == 'repository_dispatch' && github.event.client_payload.repository || '' }}";
  const names: Record<string, string> = {
    "pull-requests": "Reconcile open pull requests",
    "main-ci": "Reconcile main CI",
    "task-sources": "Reconcile task sources",
    "task-schedules": "Dispatch due scheduled tasks",
    "deploy-schedules": "Dispatch due scheduled deploys",
  };
  for (const [jobName, stepName] of Object.entries(names)) {
    const steps = workflow.jobs[jobName]?.steps ?? [];
    const step = steps.find((item) => item.name === stepName);
    assert.equal(step?.env?.AW_INTAKE_TARGET_REPOSITORY, expression, jobName);
  }
  const auditSteps = workflow.jobs["main-writes"]?.steps ?? [];
  assert.equal(
    auditSteps.some((step) => step.env?.AW_INTAKE_TARGET_REPOSITORY !== undefined),
    false,
    "Main Write Audit must always reconcile every authorized repository"
  );
});
