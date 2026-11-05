import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  finalizeIsolatedPublicState,
  prepareIsolatedPublicState,
  validateIsolatedPublicTask,
} from "../scripts/isolated-public-task.ts";
import { packTaskTransferFiles } from "../scripts/task-transfer-files.ts";
import { writeTaskStateManifest } from "../scripts/task-state.ts";

const repository = "fongap-labs/example";
const project = "test";
const sha = "a".repeat(40);
const treeSha = "b".repeat(40);
const markerSha = "c".repeat(40);
const markerPath = `projects/${project}/.isolated-task`;
const noSecrets = {
  schema_version: 1,
  tasks: { [repository]: { [project]: { required: [], allowed: [] } } },
};

function reader(
  options: {
    isPrivate?: boolean;
    entries?: unknown[];
    marker?: string;
    existingArtifacts?: number;
  } = {}
) {
  const entries = options.entries ?? [
    { path: markerPath, sha: markerSha, type: "blob", mode: "100644" },
  ];
  const marker = options.marker ?? "stateless-public-v1\n";
  const calls: string[] = [];
  return {
    calls,
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path === `repos/${repository}`) return { private: options.isPrivate ?? false };
      if (path === `repos/${repository}/git/commits/${sha}`) {
        return { tree: { sha: treeSha } };
      }
      if (path === `repos/${repository}/git/trees/${treeSha}?recursive=1`) {
        return { truncated: false, tree: entries };
      }
      if (path === `repos/${repository}/git/blobs/${markerSha}`) {
        return { encoding: "base64", content: Buffer.from(marker).toString("base64") };
      }
      if (path.startsWith("repos/fongap-labs/action-worker/actions/artifacts?")) {
        return { total_count: options.existingArtifacts ?? 0, artifacts: [] };
      }
      throw new Error("Unexpected endpoint");
    },
  };
}

async function policy(raw: unknown) {
  const root = await mkdtemp(join(tmpdir(), "aw-isolated-eligibility-"));
  const path = join(root, "policy.json");
  await writeFile(path, JSON.stringify(raw));
  return { path, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("only an explicit pinned public source with zero credentials passes pilot admission", async () => {
  const p = await policy(noSecrets);
  const r = reader();
  try {
    await validateIsolatedPublicTask(r, repository, project, sha, "task", p.path);
    assert.ok(r.calls.every((x) => !x.includes("/actions/secrets")));
    assert.ok(r.calls.every((x) => !x.includes("/environments")));
    assert.ok(r.calls.every((x) => !x.includes("/actions/variables")));
  } finally {
    await p.cleanup();
  }
});

test("private, unmarked, variable-bearing or secret-bearing task cannot enter pilot", async () => {
  const p = await policy(noSecrets);
  try {
    await assert.rejects(
      validateIsolatedPublicTask(reader({ isPrivate: true }), repository, project, sha, "task", p.path),
      /eligible/
    );
    await assert.rejects(
      validateIsolatedPublicTask(reader({ entries: [] }), repository, project, sha, "task", p.path),
      /eligible/
    );
    await assert.rejects(
      validateIsolatedPublicTask(
        reader({
          entries: [
            { path: markerPath, sha: markerSha, type: "blob", mode: "100644" },
            { path: `projects/${project}/.vars.allowed`, sha: "d".repeat(40), type: "blob", mode: "100644" },
          ],
        }),
        repository,
        project,
        sha,
        "task",
        p.path
      ),
      /eligible/
    );
    await assert.rejects(
      validateIsolatedPublicTask(reader(), repository, project, sha, "deploy", p.path),
      /eligible/
    );
  } finally {
    await p.cleanup();
  }
  const s = await policy({
    schema_version: 1,
    tasks: { [repository]: { [project]: { required: ["API_KEY"], allowed: [] } } },
  });
  try {
    await assert.rejects(
      validateIsolatedPublicTask(reader(), repository, project, sha, "task", s.path),
      /eligible/
    );
  } finally {
    await s.cleanup();
  }
});

test("all prior artifacts including unsuccessful or expired history block stateless pilot", async () => {
  const r = reader({ existingArtifacts: 1 });
  await assert.rejects(prepareIsolatedPublicState(r, repository, project, sha), /eligible/);
});

test("new public pilot state passes bounded codec and strict manifest checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-isolated-state-"));
  try {
    const packed = await prepareIsolatedPublicState(reader(), repository, project, sha);
    const dest = join(root, "new");
    await finalizeIsolatedPublicState(packed, dest, repository, project, sha);
    const data = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as Record<string, string>;
    assert.equal(data.repository, repository);
    assert.equal(data.project, project);
    assert.equal(data.bootstrap_ref, sha);
    await assert.rejects(
      finalizeIsolatedPublicState(packed, join(root, "other"), repository, "other", sha),
      /identity/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted result is rejected on path traversal, wrong manifest or extra metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-isolated-state-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeTaskStateManifest(source, repository, project, sha);
    const good = await packTaskTransferFiles(source);
    const value = JSON.parse(good.toString("utf8")) as {
      schema_version: string;
      entries: Array<{ path: string; kind: string; base64?: string }>;
    };
    const corrupted = JSON.parse(JSON.stringify(value)) as typeof value;
    corrupted.entries[0] = { ...corrupted.entries[0]!, path: "../escape" };
    await assert.rejects(
      finalizeIsolatedPublicState(
        Buffer.from(JSON.stringify(corrupted)),
        join(root, "traversal"),
        repository,
        project,
        sha
      ),
      /unsafe path/
    );
    await writeFile(join(source, "manifest.json"), JSON.stringify({
      repository, project, bootstrap_ref: sha, extra: "untrusted",
    }));
    const tampered = await packTaskTransferFiles(source);
    await assert.rejects(
      finalizeIsolatedPublicState(tampered, join(root, "extra"), repository, project, sha),
      /identity/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pilot workflow is explicitly gated; legacy job and publisher never run for pilot", async () => {
  const text = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(text) as {
    jobs: Record<string, {
      if?: string;
      needs?: string | string[];
      permissions?: Record<string, string>;
      steps?: Array<{ env?: unknown; run?: string }>;
    }>;
  };
  const jobs = workflow.jobs;
  assert.match(jobs.execute?.if ?? "", /isolation_mode != 'true'/);
  for (const name of ["prepare_isolated", "run_isolated", "finalize_isolated"]) {
    const job = jobs[name];
    assert.ok(job, name);
    assert.equal(Object.values(job.permissions ?? {}).includes("write"), false, name);
    assert.doesNotMatch(JSON.stringify(job), /AW_ARTIFACT_KEY|AW_APP_PRIVATE_KEY|AW_ADMIN_TOKEN/);
    assert.doesNotMatch(JSON.stringify(job), /\$\{\{ secrets/);
    assert.doesNotMatch(JSON.stringify(job), /AW_PUBLICATION_PRIVATE_KEY/);
  }
  assert.match(text, /AW_TASK_ISOLATION_PILOT_ENABLED/);
  assert.match(text, /AW_TASK_ISOLATION_PILOT_GROUP/);
  assert.doesNotMatch(JSON.stringify(jobs.finalize_isolated), /run:.*bootstrap\.sh/s);
  assert.deepEqual(jobs.run_isolated?.needs, ["validate", "prepare_isolated"]);
});
