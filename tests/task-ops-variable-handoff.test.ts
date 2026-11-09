import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { approvedTaskOpsAccountId } from "../scripts/task-ops-variable-handoff.ts";

const sourceRepository = "fongap-labs/internal-vault";
const project = "FongapCDN";
const id = "0123456789abcdef0123456789abcdef";

test("a task may import only a validated Account ID for its approved source and project", () => {
  assert.equal(approvedTaskOpsAccountId(sourceRepository, project, id, undefined), id);
  assert.equal(approvedTaskOpsAccountId(sourceRepository, project, undefined, id), null);
  assert.equal(approvedTaskOpsAccountId(sourceRepository, project, id, id), id);
  assert.throws(
    () => approvedTaskOpsAccountId(sourceRepository, project, "invalid", undefined),
    /invalid/
  );
  assert.throws(
    () => approvedTaskOpsAccountId(sourceRepository, project, id, "ffffffffffffffffffffffffffffffff"),
    /conflicting Variable/
  );
  assert.throws(() => approvedTaskOpsAccountId("fongap-labs/ai-gateway", project, id, ""), /not authorized/);
  assert.throws(() => approvedTaskOpsAccountId(sourceRepository, "AdFilter", id, ""), /not authorized/);
});

test("the one-way ops handoff keeps Account ID out of logs and cannot overwrite conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-task-ops-account-"));
  try {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "fongap-labs/action-worker",
      GITHUB_REF: "refs/heads/main",
      TASK_SOURCE_REPOSITORY: sourceRepository,
      PROJECT: project,
      GITHUB_OUTPUT: join(root, "ops-output"),
      GITHUB_ENV: join(root, "task-env"),
    };
    const run = (mode: string, extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["scripts/task-ops-variable-handoff.ts", mode], {
        cwd: process.cwd(),
        env: { ...env, ...extra },
        encoding: "utf8",
      });
    const exported = run("export", { CLOUDFLARE_ACCOUNT_ID_PRIMARY: id });
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "account_id=" + id + "\n");
    assert.doesNotMatch(exported.stdout + exported.stderr, new RegExp(id));
    const imported = run("import", { AW_TASK_ACCOUNT_ID_FROM_OPS: id });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(await readFile(env.GITHUB_ENV, "utf8"), "CLOUDFLARE_ACCOUNT_ID_PRIMARY=" + id + "\n");
    assert.doesNotMatch(imported.stdout + imported.stderr, new RegExp(id));
    const conflict = run("import", {
      AW_TASK_ACCOUNT_ID_FROM_OPS: id,
      CLOUDFLARE_ACCOUNT_ID_PRIMARY: "ffffffffffffffffffffffffffffffff",
    });
    assert.equal(conflict.status, 77);
    assert.match(conflict.stderr, /conflicting Variable/);
    const missing = run("export");
    assert.equal(missing.status, 77);
    const untrusted = run("export", {
      GITHUB_REF: "refs/heads/untrusted",
      CLOUDFLARE_ACCOUNT_ID_PRIMARY: id,
    });
    assert.equal(untrusted.status, 77);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task ops Job is bound to one protected Environment, no credential outputs", () => {
  const workflow = parse(readFileSync(".github/workflows/handle-task-dispatch.yml", "utf8")) as {
    jobs: Record<string, Record<string, unknown>>;
  };
  const ops = workflow.jobs.task_ops_vars;
  const execute = workflow.jobs.execute;
  assert.ok(ops && execute);
  assert.deepEqual(ops.environment, { name: "internal-vault-ops", deployment: false });
  assert.deepEqual(ops.permissions, { contents: "read" });
  assert.deepEqual(ops.needs, "validate");
  assert.deepEqual(Object.keys(ops.outputs as Record<string, unknown>), ["account_id"]);
  const gate = String(ops.if);
  assert.match(gate, /fongap-labs\/internal-vault/);
  assert.match(gate, /CLOUDFLARE_ACCOUNT_ID_PRIMARY == ''/);
  assert.match(gate, /private_isolation_mode != 'true'/);
  const projectList = gate.match(/fromJSON\('(\[[^']+\])'\)/)?.[1];
  assert.ok(projectList);
  const policy = JSON.parse(readFileSync("policies/task-secrets.json", "utf8")) as {
    tasks: Record<string, Record<string, { variable_sources?: string[] }>>;
  };
  const approved = Object.entries(policy.tasks[sourceRepository] ?? {})
    .filter(([, value]) => value.variable_sources?.includes("CLOUDFLARE_ACCOUNT_ID_PRIMARY"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual((JSON.parse(projectList) as string[]).sort(), approved);
  const steps = ops.steps as Array<{ name: string; env?: Record<string, string>; run?: string }>;
  const outputStep = steps.find((x) => x.name.includes("Validate and export"));
  assert.equal(outputStep?.run, "node scripts/task-ops-variable-handoff.ts export");
  assert.deepEqual(Object.keys(outputStep?.env ?? {}).sort(), [
    "CLOUDFLARE_ACCOUNT_ID_PRIMARY",
    "PROJECT",
    "TASK_SOURCE_REPOSITORY",
  ]);
  assert.doesNotMatch(JSON.stringify(ops), /secrets\.|AW_ADMIN_TOKEN|permission-secrets/);
  assert.deepEqual(execute.needs, ["validate", "task_ops_vars"]);
  assert.match(String(execute.if), /!cancelled\(\)/);
  assert.match(String(execute.if), /needs\.task_ops_vars\.result == 'skipped'/);
  const importStep = (execute.steps as Array<{ run?: string; env?: Record<string, string> }>).find(
    (x) => x.run === "node scripts/task-ops-variable-handoff.ts import"
  );
  assert.equal(
    importStep?.env?.AW_TASK_ACCOUNT_ID_FROM_OPS,
    "${{ needs.task_ops_vars.outputs.account_id }}"
  );
});
