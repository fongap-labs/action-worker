import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectDeltaPruneInventory,
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
