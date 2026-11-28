import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDependencyPolicy } from "../scripts/dependency-version-policy.ts";
import { compareDependencyTrees } from "../scripts/validate-dependency-drift.ts";

const repo = "fongap-labs/example";
const today = "2026-11-27";
const policy = parseDependencyPolicy(
  {
    schema_version: 1,
    mode: "ratchet",
    default_class: "project",
    catalog: {
      "tool:node": { class: "toolchain", version: "26.13.1" },
      "npm:typescript": { class: "engineering", version: "7.0.2" },
      "npm:react": { class: "framework", version: null },
    },
    exceptions: [
      {
        repository: repo,
        branch: "dev",
        dependency: "tool:node",
        declaration: "22.0.0",
        reason: "Temporary migration",
        expires_on: today,
      },
    ],
  },
  "fongap-labs"
);

function tree(files: Record<string, string>) {
  return new Map(Object.entries(files).map(([path, sha]) => [path, { sha }]));
}

const read = async (blob: { sha: string }) => blob.sha;
const check = (
  before: Record<string, string>,
  after: Record<string, string>,
  branch: "main" | "dev" = "main"
) => compareDependencyTrees(policy, repo, branch, tree(before), tree(after), read, today);

test("ratchet permits unchanged drift and improvements but rejects new or moved drift", async () => {
  const path = "package.json";
  const old = '{"engines":{"node":"22.0.0"}}';
  const next = '{"engines":{"node":"26.13.1"}}';
  assert.equal((await check({ [path]: old }, { [path]: old })).introduced, 0);
  assert.equal((await check({ [path]: old }, { [path]: next })).introduced, 0);
  assert.equal((await check({ [path]: next }, { [path]: old })).introduced, 1);
  assert.equal((await check({ [path]: old }, { "apps/new/package.json": old })).introduced, 1);
  assert.equal((await check({}, { [path]: old }, "dev")).introduced, 0);
});

test("new engineering ranges and duplicate drifting declarations are blocked", async () => {
  const path = "package.json";
  const old = '{"devDependencies":{"typescript":"6.0.3"}}';
  const next = '{"devDependencies":{"typescript":"6.0.3"},"dependencies":{"typescript":"6.0.3"}}';
  assert.equal((await check({ [path]: old }, { [path]: next })).introduced, 1);
  assert.equal(
    (await check({}, { [path]: '{"devDependencies":{"typescript":"^7.0.2"}}' })).introduced,
    1
  );
  assert.equal((await check({}, { [path]: '{"dependencies":{"react":"19.0.0"}}' })).introduced, 0);
  await assert.rejects(check({}, { [path]: "{invalid" }));
});

test("native compiler aliases obey the same central version gate", async () => {
  const path = "package.json";
  const manifest = (version: string) =>
    JSON.stringify({ devDependencies: { "@typescript/native": "npm:typescript@" + version } });
  const pinned = manifest("7.0.2");
  assert.equal((await check({}, { [path]: pinned })).introduced, 0);
  assert.equal((await check({ [path]: pinned }, { [path]: manifest("6.0.3") })).introduced, 1);
  assert.equal((await check({ [path]: pinned }, { [path]: manifest("^7.0.2") })).introduced, 1);
});
