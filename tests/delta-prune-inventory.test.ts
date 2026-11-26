import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeDeltaPruneClosure,
  inspectDeltaPruneInventory,
  inspectDeltaSourceMatches,
  parseDeltaPruneTree,
} from "../scripts/delta-prune-inventory.ts";
import { parseDeltaPrunePolicy } from "../scripts/delta-prune-policy.ts";

const sha = "a".repeat(40);
const policy = parseDeltaPrunePolicy(
  JSON.stringify({
    version: "v1",
    allowedProducts: ["desktop"],
    allowedCapabilities: ["agent"],
    allowedEntrypoints: ["apps/desktop"],
    allowedArtifacts: ["desktop"],
    deniedCapabilities: ["telemetry"],
    deniedPackages: ["packages/old", "@example/old"],
    deniedDependencies: ["@example/tracker"],
    exceptions: [],
    thresholds: {},
  }),
  0
).policy;

function entry(path: string, mode = "100644"): string {
  return mode + " blob " + sha + "\t" + path + "\0";
}

test("static inventory permits approved app and required internal dependency", () => {
  const tree = parseDeltaPruneTree(entry("package.json") + entry("apps/desktop/package.json"));
  const manifests = new Map([
    ["package.json", "{}"],
    ["apps/desktop/package.json", '{"dependencies":{"@example/core":"workspace:*"}}'],
  ]);
  assert.deepEqual(inspectDeltaPruneInventory(policy, tree, manifests), []);
});

test("static inventory denies unapproved apps, renamed packages and dependency aliases", () => {
  const tree = parseDeltaPruneTree(
    entry("package.json") +
      entry("apps/extra/src/index.ts") +
      entry("packages/old/src/index.ts") +
      entry("packages/new/package.json")
  );
  const findings = inspectDeltaPruneInventory(
    policy,
    tree,
    new Map([
      ["package.json", "{}"],
      [
        "packages/new/package.json",
        JSON.stringify({
          name: "@example/old",
          optionalDependencies: { alias: "npm:@example/tracker@1.0.0" },
        }),
      ],
    ])
  );
  assert.deepEqual(findings, [
    "Denied dependency: @example/tracker in packages/new/package.json",
    "Denied package name: @example/old in packages/new/package.json",
    "Denied package path: packages/old",
    "Unapproved application root: apps/extra",
  ]);
});

test("static inventory fails on missing, malformed and non-regular manifest evidence", () => {
  const tree = parseDeltaPruneTree(
    entry("package.json") +
      entry("packages/a/package.json") +
      entry("packages/b/package.json", "120000")
  );
  assert.deepEqual(inspectDeltaPruneInventory(policy, tree, new Map([["package.json", "{"]])), [
    "Invalid package manifest: package.json",
    "Missing package manifest evidence: packages/a/package.json",
    "Non-regular package manifest: packages/b/package.json",
  ]);
  assert.throws(() => parseDeltaPruneTree("partial"), /Incomplete/);
  assert.throws(
    () => parseDeltaPruneTree(entry("package.json") + entry("package.json")),
    /Invalid/
  );
});

test("declared closure separates runtime and development dependencies, including cycles", () => {
  const manifests = new Map(
    Object.entries({
      "package.json": {},
      "apps/desktop/package.json": {
        dependencies: { alias: "workspace:@example/core@*" },
        devDependencies: { "@example/test": "workspace:*" },
      },
      "packages/core/main/package.json": {
        name: "@example/core",
        peerDependencies: { "@example/peer": "workspace:*" },
      },
      "packages/core/peer/package.json": {
        name: "@example/peer",
        dependencies: { "@example/core": "workspace:*" },
      },
      "packages/test/tool/package.json": { name: "@example/test" },
      "packages/old/orphan/package.json": { name: "@example/orphan" },
    }).map(([path, value]) => [path, JSON.stringify(value)])
  );
  const result = describeDeltaPruneClosure(policy, manifests);
  assert.deepEqual(result.roots, [
    {
      entry: "apps/desktop",
      manifest: "apps/desktop/package.json",
      runtime: [
        "apps/desktop/package.json",
        "packages/core/main/package.json",
        "packages/core/peer/package.json",
      ],
      includingDevelopment: [
        "apps/desktop/package.json",
        "packages/core/main/package.json",
        "packages/core/peer/package.json",
        "packages/test/tool/package.json",
      ],
    },
  ]);
  assert.deepEqual(result.reverseConsumers["packages/core/main/package.json"], [
    "apps/desktop/package.json",
    "packages/core/peer/package.json",
  ]);
  assert.deepEqual(result.reviewCandidates, ["package.json", "packages/old/orphan/package.json"]);
  assert.deepEqual(result.unresolved, []);
});

test("declared closure reports ambiguous, missing and registry edges without proving deletion", () => {
  const manifests = new Map(
    Object.entries({
      "apps/desktop/package.json": {
        dependencies: {
          ambiguous: "workspace:*",
          missing: "workspace:*",
          registry: "1.0.0",
          local: "workspace:../../packages/core/linked",
        },
      },
      "packages/core/one/package.json": { name: "ambiguous" },
      "packages/core/two/package.json": { name: "ambiguous" },
      "packages/core/registry/package.json": { name: "registry" },
      "packages/core/linked/package.json": { name: "linked" },
    }).map(([path, value]) => [path, JSON.stringify(value)])
  );
  const result = describeDeltaPruneClosure(
    { ...policy, allowedEntrypoints: ["apps/desktop", "apps/unknown"] },
    manifests
  );
  assert.deepEqual(result.roots[0]?.runtime, [
    "apps/desktop/package.json",
    "packages/core/linked/package.json",
  ]);
  assert.deepEqual(result.unresolved, [
    "apps/desktop/package.json:dependencies:ambiguous",
    "apps/desktop/package.json:dependencies:missing",
    "apps/desktop/package.json:dependencies:registry",
    "entry:apps/unknown",
  ]);
});

test("source privacy rules permit exact approved references only and never return paths", () => {
  const tree = parseDeltaPruneTree(
    entry("scripts/guard.ts") +
      entry("apps/desktop/src/tracker.ts") +
      entry("scripts/guard.ts.bak")
  );
  const rule = { term: "dsh_session_log", allowedPaths: ["scripts/guard.ts"] };
  const raw = tree.map((item) => sha + ":" + item.path + "\0").join("");
  assert.deepEqual(inspectDeltaSourceMatches(rule, sha, raw, tree), {
    term: rule.term,
    denied: 2,
    approvedReferences: 1,
  });
  assert.deepEqual(inspectDeltaSourceMatches(rule, sha, "", tree), {
    term: rule.term,
    denied: 0,
    approvedReferences: 0,
  });
  assert.throws(() => inspectDeltaSourceMatches(rule, sha, raw.slice(0, -1), tree), /Incomplete/);
  assert.throws(() => inspectDeltaSourceMatches(rule, sha, sha + ":unknown\0", tree), /Invalid/);
});
