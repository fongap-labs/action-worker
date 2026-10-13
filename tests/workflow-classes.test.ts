import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Job = {
  "timeout-minutes"?: unknown;
  uses?: unknown;
  concurrency?: unknown;
  permissions?: unknown;
  steps?: Array<{ uses?: unknown }>;
};
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: unknown;
  jobs?: Record<string, Job>;
};

const workflowDirectory = ".github/workflows";

// Every workflow belongs to exactly one class. The class decides how the workflow starts and what
// it may declare, so workflows of one class are set up the same way. A new workflow is added to one
// class here; a workflow that fits none is a design question, not a new class by default.
const classes = {
  // The only workflows a person starts: each one has a Run workflow button in the Actions tab with
  // described inputs, and automation starts the same work through repository_dispatch.
  entry: ["deploy-source-script.yml", "release-app.yml", "task-source-dispatch.yml"],
  // The one reconciler. It sweeps every managed repository and dispatches the work it finds.
  intake: ["intake.yml"],
  // Started by an event another workflow or a managed repository sends; never by a person or a
  // schedule.
  handler: [
    "cancel-pr-work.yml",
    "central-ci-dispatch.yml",
    "dependency-repair-dispatch.yml",
    "handle-pr-dispatch.yml",
    "handle-pr-review.yml",
    "handle-release-dispatch.yml",
    "handle-task-dispatch.yml",
    "security-scan-dispatch.yml",
  ],
  // Keeps Action Worker itself current: started by its own pushes, pull requests, schedules or
  // finished runs.
  maintenance: [
    "apply-repository-settings.yml",
    "main-write-guard.yml",
    "prune-stale-branches.yml",
    "release-tool.yml",
    "update-work-metrics.yml",
    "validate-ci.yml",
  ],
  // Called by other workflows only.
  reusable: ["central-ci-sandbox.yml"],
} as const;

type WorkflowClass = keyof typeof classes;

// The events each class may be started by.
const allowedTriggers: Record<WorkflowClass, readonly string[]> = {
  entry: ["repository_dispatch", "workflow_dispatch"],
  intake: ["push", "repository_dispatch", "schedule"],
  handler: ["repository_dispatch"],
  maintenance: ["pull_request", "push", "schedule", "workflow_run"],
  reusable: ["workflow_call"],
};

async function workflows(): Promise<Array<{ file: string; workflow: Workflow }>> {
  const files = (await readdir(workflowDirectory)).filter((file) => file.endsWith(".yml")).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      workflow: parse(await readFile(`${workflowDirectory}/${file}`, "utf8")) as Workflow,
    }))
  );
}

function classOf(file: string): WorkflowClass {
  const owners = (Object.keys(classes) as WorkflowClass[]).filter((name) =>
    (classes[name] as readonly string[]).includes(file)
  );
  assert.equal(owners.length, 1, `${file} belongs to ${owners.length} workflow classes`);
  return owners[0] as WorkflowClass;
}

function hasWrite(permissions: unknown): boolean {
  if (permissions === "write-all") return true;
  if (typeof permissions !== "object" || permissions === null) return false;
  return Object.values(permissions).includes("write");
}

test("every workflow belongs to exactly one class and every class entry exists", async () => {
  const files = (await workflows()).map(({ file }) => file);
  for (const file of files) classOf(file);
  const listed = Object.values(classes).flat();
  assert.deepEqual([...listed].sort(), files, "the workflow classes list exactly the workflows");
});

test("each workflow is started only by the events its class allows", async () => {
  for (const { file, workflow } of await workflows()) {
    const kind = classOf(file);
    const triggers = Object.keys(workflow.on ?? {});
    assert.ok(triggers.length > 0, `${file} declares no trigger`);
    for (const trigger of triggers) {
      assert.ok(
        allowedTriggers[kind].includes(trigger),
        `${file} is a ${kind} workflow and must not start on ${trigger}`
      );
    }
  }
});

test("only entry workflows show a Run workflow button, and each one explains its inputs", async () => {
  for (const { file, workflow } of await workflows()) {
    const kind = classOf(file);
    const triggers = workflow.on ?? {};
    if (kind !== "entry") {
      assert.equal("workflow_dispatch" in triggers, false, `${file} must not be started by hand`);
      continue;
    }
    assert.ok(
      "workflow_dispatch" in triggers,
      `${file} is an entry and declares workflow_dispatch`
    );
    assert.ok("repository_dispatch" in triggers, `${file} is an entry automation can also start`);
    const manual = triggers.workflow_dispatch as { inputs?: Record<string, unknown> } | null;
    const inputs = Object.entries(manual?.inputs ?? {});
    assert.ok(inputs.length > 0, `${file} asks for what to run`);
    for (const [name, input] of inputs) {
      const description = (input as { description?: unknown }).description;
      assert.equal(typeof description, "string", `${file} input ${name} has a description`);
    }
  }
});

test("the reconciler wakes on main pushes and run-intake, not only on the schedule", async () => {
  const intake = (await workflows()).find(({ file }) => file === "intake.yml");
  assert.ok(intake);
  const triggers = intake.workflow.on ?? {};
  assert.deepEqual((triggers.repository_dispatch as { types?: unknown }).types, ["run-intake"]);
  assert.deepEqual((triggers.push as { branches?: unknown }).branches, ["main"]);
});

test("workflows grant no write permission at the workflow level", async () => {
  for (const { file, workflow } of await workflows()) {
    if (classOf(file) === "reusable") continue;
    assert.notEqual(workflow.permissions, undefined, `${file} declares its permissions`);
    assert.equal(
      hasWrite(workflow.permissions),
      false,
      `${file} grants write at the workflow level; grant it on the job that writes`
    );
  }
});

test("every job has a timeout, and every action is pinned to a full commit SHA", async () => {
  for (const { file, workflow } of await workflows()) {
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (typeof job.uses === "string") {
        assert.match(job.uses, /^\.\/\.github\/workflows\/[a-z0-9-]+\.yml$/, `${file} ${name}`);
        continue;
      }
      assert.equal(typeof job["timeout-minutes"], "number", `${file} job ${name} has a timeout`);
      for (const step of job.steps ?? []) {
        if (typeof step.uses !== "string" || step.uses.startsWith("./")) continue;
        assert.match(step.uses, /@[0-9a-f]{40}$/, `${file} job ${name} pins ${step.uses}`);
      }
    }
  }
});

test("every started workflow bounds its concurrency", async () => {
  for (const { file, workflow } of await workflows()) {
    if (classOf(file) === "reusable") continue;
    const jobs = Object.values(workflow.jobs ?? {});
    assert.ok(
      workflow.concurrency !== undefined || jobs.some((job) => job.concurrency !== undefined),
      `${file} declares a concurrency group`
    );
  }
});

test("Action Worker never runs pull request code with its secrets", async () => {
  for (const { file, workflow } of await workflows()) {
    assert.equal("pull_request_target" in (workflow.on ?? {}), false, file);
  }
});
