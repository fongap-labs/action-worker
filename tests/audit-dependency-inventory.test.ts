import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  inspectManifest,
  inspectRef,
  inventoryDependencies,
} from "../scripts/audit-dependency-inventory.ts";
import { parseDependencyPolicy } from "../scripts/dependency-version-policy.ts";
import { GithubHttpError } from "../scripts/github-api.ts";

test("inventory reads npm declarations without leaking remote specifications", () => {
  const result = inspectManifest(
    "packages/example/package.json",
    JSON.stringify({
      engines: { node: ">=24" },
      packageManager: "pnpm@11.28.5",
      dependencies: { react: "^19.0.0", private: "https://example.test/secret/file" },
    })
  );
  assert.deepEqual(result.declarations, [
    { key: "npm:react", version: "^19.0.0" },
    { key: "tool:node", version: ">=24" },
    { key: "tool:pnpm", version: "11.28.5" },
  ]);
  assert.equal(result.unsupported, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("inventory reads workspace, Python and Rust version declarations", () => {
  assert.deepEqual(
    inspectManifest("pnpm-workspace.yaml", 'catalog:\n  react: "19.0.0"').declarations,
    [{ key: "npm:react", version: "19.0.0" }]
  );
  assert.deepEqual(
    inspectManifest("pyproject.toml", '[project]\ndependencies = ["Requests>=2.0"]').declarations,
    [{ key: "python:requests", version: ">=2.0" }]
  );
  assert.deepEqual(inspectManifest("Cargo.toml", '[dependencies]\nserde = "1.0"').declarations, [
    { key: "cargo:serde", version: "1.0" },
  ]);
});

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const blob = "c".repeat(40);

function fixtureReader(truncated = false, moved = false) {
  const calls: string[] = [];
  const branchReads = new Map<string, number>();
  return {
    calls,
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path.endsWith("/branches/dev")) throw new GithubHttpError(404);
      const content = JSON.stringify({
        dependencies: { react: path.includes("/two/") ? "19.0.0" : "18.0.0" },
      });
      if (path.endsWith("/branches/main")) {
        const count = (branchReads.get(path) ?? 0) + 1;
        branchReads.set(path, count);
        return {
          name: "main",
          commit: { sha: moved && count > 1 ? blob : sha, commit: { tree: { sha: tree } } },
        };
      }
      if (path.endsWith("/git/trees/" + tree + "?recursive=1")) {
        return {
          truncated,
          tree: [
            {
              path: "packages/example/package.json",
              type: "blob",
              mode: "100644",
              size: Buffer.byteLength(content),
              sha: blob,
            },
            { path: "pnpm-lock.yaml", type: "blob" },
          ],
        };
      }
      if (path.endsWith("/git/blobs/" + blob)) {
        return { encoding: "base64", content: Buffer.from(content).toString("base64") };
      }
      throw new Error("Unexpected request.");
    },
  };
}

test("branch inventory uses immutable Git objects and marks truncation and movement", async () => {
  const reader = fixtureReader();
  const result = await inspectRef(reader, "example/one", "main");
  assert.equal(result.state, "scanned");
  assert.equal(result.manifests, 1);
  assert.equal(result.locks, 1);
  assert.equal((await inspectRef(reader, "example/one", "dev")).state, "absent");
  assert.equal((await inspectRef(fixtureReader(true), "example/one", "main")).state, "incomplete");
  assert.equal(
    (await inspectRef(fixtureReader(false, true), "example/one", "main")).state,
    "incomplete"
  );
});

test("new repositories are discovered without grants, and private details stay redacted", async () => {
  const reader = fixtureReader();
  const result = await inventoryDependencies(
    reader,
    [
      { full_name: "example/one", private: false, archived: false },
      { full_name: "example/two", private: false, archived: false },
      { full_name: "example/hidden", private: true, archived: false },
      { full_name: "example/old", private: false, archived: true },
    ],
    "example",
    [],
    parseDependencyPolicy(
      {
        schema_version: 1,
        mode: "advisory",
        default_class: "project",
        catalog: { "npm:react": { class: "engineering", version: "19.0.0" } },
        exceptions: [],
      },
      "example"
    ),
    "2026-11-27"
  );
  assert.equal(result.inventory_repositories, 4);
  assert.equal(result.private_repositories, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.policy_counts.matching, 1);
  assert.equal(result.policy_counts.different, 2);
  assert.equal(result.public_policy_findings.length, 1);
  assert.equal(result.common_public_dependencies[0]?.differentDeclarations, true);
  assert.equal(result.common_public_dependencies[0]?.key, "main/npm:react");
  assert.doesNotMatch(JSON.stringify(result), /hidden/);
  assert.ok(reader.calls.some((path) => path.includes("/hidden/")));
  assert.ok(!reader.calls.some((path) => path.includes("/old/")));
});

test("scheduled inventory reuses existing read-only App credential", () => {
  const workflow = parse(readFileSync(".github/workflows/audit-config-scope.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; env?: unknown; run?: string }> }>;
  };
  const step = workflow.jobs.audit?.steps.find(
    (item) => item.run === "node scripts/audit-dependency-inventory.ts"
  );
  assert.deepEqual(step?.env, {
    AW_INVENTORY_TOKEN: "${{ steps.privacy_inventory.outputs.token }}",
  });
});
