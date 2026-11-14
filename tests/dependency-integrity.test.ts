import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectNpmLock } from "../scripts/dependency-integrity.ts";

const integrity = "sha512-" + "a".repeat(64);
const make = (entries: Record<string, unknown>) => ({
  lockfileVersion: 3,
  packages: { "": { name: "fixture" }, ...entries },
});

test("offline npm integrity gate accepts safe locked packages and workspace links", () => {
  assert.deepEqual(inspectNpmLock(make({
    "node_modules/fixture": { resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", integrity },
    "node_modules/local": { resolved: "file:../shared" },
    "node_modules/link": { resolved: "file:packages/a", link: true },
  })), []);
});

test("offline integrity gate blocks credentials, insecure transport and missing digests", () => {
  const findings = inspectNpmLock(make({
    "node_modules/a": { resolved: "http://registry.invalid/a.tgz", integrity },
    "node_modules/b": { resolved: "https://user:password@registry.invalid/b.tgz" },
  }));
  assert.ok(findings.includes("insecure-registry-transport"));
  assert.ok(findings.includes("embedded-registry-credentials"));
  assert.ok(findings.includes("missing-lockfile-integrity"));
  assert.equal(JSON.stringify(findings).includes("password"), false);
});

test("offline integrity gate rejects mutable git revisions and malformed lockfiles", () => {
  assert.ok(inspectNpmLock(make({
    "node_modules/git": { resolved: "git+https://github.com/example/example.git#main" },
  })).includes("unlocked-git-revision"));
  assert.throws(() => inspectNpmLock({ lockfileVersion: 1, packages: {} }));
  assert.throws(() => inspectNpmLock({ lockfileVersion: 3 }));
});

test("the dependency integrity gate makes no network requests or npm install", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("scripts/dependency-integrity.ts", "utf8"));
  assert.doesNotMatch(source, /spawnSync\s*\(|\bfetch\s*\(|npm\s+(?:ci|install|audit)/);
});

test("central CI fails closed on dependency integrity findings", async () => {
  const workflow = await import("node:fs/promises").then((fs) => fs.readFile(".github/workflows/central-ci-dispatch.yml", "utf8"));
  assert.match(workflow, /- name: Check dependency lockfile integrity/);
  assert.match(workflow, /node scripts\/dependency-integrity\.ts/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true\s*\n\s*env:\s*\n\s*BASE_SHA/);
});
