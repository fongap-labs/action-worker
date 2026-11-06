import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { validatePrivateIsolationAdmission } from "../scripts/isolated-private-task.ts";

const repository = "fongap-labs/private-example";
const project = "sample";
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);
const markerPath = `projects/${project}/.isolated-private-task`;
const allowed = {
  schema_version: 1,
  tasks: { [repository]: { [project]: { required: [], allowed: [] } } },
};

async function fixture(policy: unknown) {
  const root = await mkdtemp(join(tmpdir(), "aw-private-admission-"));
  const file = join(root, "policy.json");
  await writeFile(file, JSON.stringify(policy));
  return { file, remove: () => rm(root, { recursive: true, force: true }) };
}

function reader(options: { visibility?: boolean; marker?: string; extras?: unknown[] } = {}) {
  const marker = options.marker ?? "stateful-private-v1\n";
  const calls: string[] = [];
  return {
    calls,
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path === `repos/${repository}`) return { private: options.visibility ?? true };
      if (path === `repos/${repository}/git/commits/${commitSha}`) {
        return { tree: { sha: treeSha } };
      }
      if (path === `repos/${repository}/git/trees/${treeSha}?recursive=1`) {
        return {
          truncated: false,
          tree: [
            { path: markerPath, type: "blob", mode: "100644", sha: blobSha },
            ...(options.extras ?? []),
          ],
        };
      }
      if (path === `repos/${repository}/git/blobs/${blobSha}`) {
        return { encoding: "base64", content: Buffer.from(marker).toString("base64") };
      }
      throw new Error("Unexpected Git API path");
    },
  };
}

test("private pilot requires a pinned private, credential-free project with an exact source marker", async () => {
  const f = await fixture(allowed);
  try {
    const r = reader();
    await validatePrivateIsolationAdmission(r, repository, project, commitSha, "task", f.file);
    assert.equal(
      r.calls.some((x) => x.includes("/actions/secrets")),
      false
    );
    await assert.rejects(
      validatePrivateIsolationAdmission(
        reader({ visibility: false }),
        repository,
        project,
        commitSha,
        "task",
        f.file
      ),
      /eligible/
    );
    await assert.rejects(
      validatePrivateIsolationAdmission(
        reader({ marker: "stateful-private-v1\r\n" }),
        repository,
        project,
        commitSha,
        "task",
        f.file
      ),
      /eligible/
    );
    await assert.rejects(
      validatePrivateIsolationAdmission(reader(), repository, project, commitSha, "deploy", f.file),
      /eligible/
    );
  } finally {
    await f.remove();
  }
});

test("private pilot rejects task Variables, source Secret declarations, and central Secret allowances", async () => {
  const f = await fixture(allowed);
  try {
    await assert.rejects(
      validatePrivateIsolationAdmission(
        reader({
          extras: [
            {
              path: `projects/${project}/.vars.allowed`,
              type: "blob",
              mode: "100644",
              sha: "d".repeat(40),
            },
          ],
        }),
        repository,
        project,
        commitSha,
        "task",
        f.file
      ),
      /eligible/
    );
  } finally {
    await f.remove();
  }
  const g = await fixture({
    schema_version: 1,
    tasks: { [repository]: { [project]: { required: ["API_KEY"], allowed: [] } } },
  });
  try {
    await assert.rejects(
      validatePrivateIsolationAdmission(reader(), repository, project, commitSha, "task", g.file),
      /eligible/
    );
  } finally {
    await g.remove();
  }
});

test("private pilot is separately gated, three fresh Jobs and no fallback to legacy job", async () => {
  const raw = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(raw) as {
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string[];
        permissions?: Record<string, string>;
        steps?: Array<{ uses?: string; run?: string; env?: unknown }>;
      }
    >;
  };
  const jobs = workflow.jobs;
  for (const key of [
    "prepare_private_isolated",
    "run_private_isolated",
    "finalize_private_isolated",
  ]) {
    assert.ok(jobs[key], key);
    assert.equal(Object.values(jobs[key]?.permissions ?? {}).includes("write"), false);
    assert.doesNotMatch(JSON.stringify(jobs[key]), /env:\s*\$\{\{\s*secrets\s*\}\}/);
  }
  assert.match(raw, /AW_PRIVATE_ISOLATION_PILOT_ENABLED/);
  assert.match(raw, /AW_PRIVATE_ISOLATION_PILOT_GROUP/);
  assert.match(raw, /AW_PRIVATE_ISOLATION_LOCK_ATTESTED/);
  assert.match(jobs.execute?.if ?? "", /private_isolation_mode != 'true'/);
  assert.match(JSON.stringify(jobs.run_private_isolated), /private-task-container\.ts/);
  assert.match(
    JSON.stringify(jobs.finalize_private_isolated),
    /finalize-trusted-task-artifacts\.ts/
  );
  assert.doesNotMatch(
    JSON.stringify(jobs.run_private_isolated),
    /AW_ARTIFACT_KEY|AW_APP_PRIVATE_KEY|AW_PUBLICATION_PRIVATE_KEY/
  );
  assert.doesNotMatch(JSON.stringify(jobs.finalize_private_isolated), /bootstrap\.sh/);
  assert.match(JSON.stringify(jobs.prepare_private_isolated), /prepare-trusted-task-state\.ts/);
});

test("workflow-level lock spans private prepare, execution, and finalization without cancellation", async () => {
  const raw = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(raw) as {
    concurrency?: {
      group?: string;
      "cancel-in-progress"?: boolean;
      queue?: string;
    };
    jobs: Record<string, { needs?: string[]; concurrency?: unknown }>;
  };
  const lock = workflow.concurrency;
  assert.ok(lock, "task lifecycle must have a workflow-level lock");
  assert.equal(lock["cancel-in-progress"], false);
  assert.equal(lock.queue, "max", "pending task runs must not replace earlier requests");
  assert.match(lock.group ?? "", /github\.event\.client_payload\.repository/);
  assert.match(lock.group ?? "", /github\.event\.client_payload\.project/);
  assert.doesNotMatch(lock.group ?? "", /request_id|run_id|bootstrap_ref|run_attempt/);
  assert.deepEqual(workflow.jobs.run_private_isolated?.needs, [
    "validate",
    "prepare_private_isolated",
  ]);
  assert.deepEqual(workflow.jobs.finalize_private_isolated?.needs, [
    "validate",
    "prepare_private_isolated",
    "run_private_isolated",
  ]);
  // Job-level lock alone is insufficient because it does not include restore
  // and finalize; retain it only as a compatibility boundary for legacy jobs.
  assert.ok(workflow.jobs.run_private_isolated?.concurrency);
});
