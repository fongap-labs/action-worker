import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { trustedIntakeTarget } from "../scripts/intake-event-scope.ts";
import { shouldRunIntakeCapability } from "../scripts/repository-policy.ts";

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

test("capability gate is fail-open except for a known repository without the grant", () => {
  assert.equal(shouldRunIntakeCapability(policy, "task", "fongap-labs/dsh-plugin"), false);
  assert.equal(shouldRunIntakeCapability(policy, "pr", "fongap-labs/dsh-plugin"), true);
  assert.equal(shouldRunIntakeCapability(policy, "deploy", "fongap-labs/ai-gateway"), true);
  assert.equal(shouldRunIntakeCapability(policy, "deploy", "fongap-labs/dsh-plugin"), false);
  for (const hint of ["", "fongap-labs/new-repository", "../other", "other-org/repo"]) {
    assert.equal(shouldRunIntakeCapability(policy, "deploy", hint), true, hint);
  }
});

test("irrelevant wake-up targets skip token mint, but not main-write audit", async () => {
  const workflow = parse(await readFile(".github/workflows/intake.yml", "utf8")) as {
    jobs: Record<
      string,
      {
        steps: Array<{ name?: string; if?: string; env?: Record<string, string> }>;
      }
    >;
  };
  const target =
    "${{ github.event_name == 'repository_dispatch' && github.event.client_payload.repository || '' }}";
  const scopes: Record<string, [string, string]> = {
    "pull-requests": ["pr_scope", "Resolve PR repository scope"],
    "main-ci": ["pr_scope", "Resolve PR repository scope"],
    "task-sources": ["task_scope", "Resolve task repository scope"],
    "task-schedules": ["task_scope", "Resolve task repository scope"],
    "deploy-schedules": ["deploy_scope", "Resolve deploy repository scope"],
  };
  for (const [job, [scope, name]] of Object.entries(scopes)) {
    const steps = workflow.jobs[job]?.steps ?? [];
    assert.equal(
      steps.find((step) => step.name === name)?.env?.AW_INTAKE_TARGET_REPOSITORY,
      target
    );
    for (const step of steps.filter((item) => item.name?.startsWith("Mint "))) {
      assert.ok(
        step.if?.includes(`steps.${scope}.outputs.scan != 'false'`),
        `${job}: ${step.name} should skip a known irrelevant target`
      );
    }
    const reconcile = steps.at(-1);
    assert.ok(reconcile?.if?.includes(`steps.${scope}.outputs.scan != 'false'`), job);
  }
  assert.equal(
    (workflow.jobs["main-writes"]?.steps ?? []).some((step) => step.if?.includes("outputs.scan")),
    false
  );
});
