import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditTaskArtifacts,
  inventoryCandidates,
} from "../scripts/audit-private-task-artifacts.ts";
import { taskStateArtifactName } from "../scripts/task-state.ts";

const pair = { repository: "o/private", project: "SecretProject" };
const name = taskStateArtifactName(pair.repository, pair.project);
const validRun = {
  path: ".github/workflows/handle-task-dispatch.yml",
  head_branch: "main",
  conclusion: "success",
};
const artifact = (id: number, run: number, expired = false) => ({
  id,
  name,
  expired,
  workflow_run: { id: run },
});

test("policy candidate discovery preserves exact scope and rejects bad identifiers", () => {
  const candidates = inventoryCandidates({
    tasks: { "o/private": { SecretProject: { secrets: [] }, Another: {} } },
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.project).sort(), ["Another", "SecretProject"]);
  assert.throws(() => inventoryCandidates({ tasks: { "wrong": { P: {} } } }));
  assert.throws(() => inventoryCandidates({ tasks: { "o/r": { "../bad": {} } } }));
});

test("only successful main task workflow runs count as trusted metadata", async () => {
  const seen: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      seen.push(path);
      if (path.includes("/actions/artifacts?")) {
        return { artifacts: [
          artifact(1, 11),
          artifact(2, 12),
          artifact(3, 13),
          artifact(4, 14, true),
        ] };
      }
      const run = Number(path.split("/").at(-1));
      if (run === 11) return validRun;
      if (run === 12) return { ...validRun, conclusion: "failure" };
      if (run === 13) return { ...validRun, path: ".github/workflows/other.yml" };
      throw new Error("Unexpected API request");
    },
  };
  const output = await auditTaskArtifacts(reader, "o/control", [pair]);
  assert.equal(output.status, "INCOMPLETE");
  assert.equal(output.scope, "artifact-metadata-only");
  assert.deepEqual(output.candidates[0]?.trusted_run_ids, [11]);
  assert.equal(output.candidates[0]?.trusted_artifact_count, 1);
  assert.equal(output.candidates[0]?.untrusted_artifact_count, 2);
  assert.equal(output.candidates[0]?.expired_artifact_count, 1);
  assert.equal(output.candidates[0]?.artifact_listing_complete, true);
  const json = JSON.stringify(output);
  assert.equal(json.includes("SecretProject"), false);
  assert.equal(json.includes("o/private"), false);
  assert.equal(json.includes(name), false);
  assert.equal(seen.some((path) => path.includes("/actions/runs/14")), false);
  assert.equal(seen.some((path) => /download|logs/.test(path)), false);
});

test("rejects mismatched artifact identity rather than counting it", async () => {
  const reader = {
    async get(): Promise<unknown> {
      return { artifacts: [{ ...artifact(1, 11), name: "forged-name" }] };
    },
  };
  await assert.rejects(auditTaskArtifacts(reader, "o/control", [pair]), /identity/);
});

test("a truncated listing stays incomplete instead of falsely reporting coverage", async () => {
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path.includes("/actions/artifacts?")) {
        return { artifacts: Array.from({ length: 100 }, (_, index) => artifact(index + 1, 1)) };
      }
      return validRun;
    },
  };
  const output = await auditTaskArtifacts(reader, "o/control", [pair]);
  assert.equal(output.candidates[0]?.artifact_count, 300);
  assert.equal(output.candidates[0]?.artifact_listing_complete, false);
  assert.equal(output.status, "INCOMPLETE");
});
