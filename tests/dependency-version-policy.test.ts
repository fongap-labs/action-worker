import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  evaluateDeclaration,
  parseDependencyPolicy,
} from "../scripts/dependency-version-policy.ts";

const date = "2026-11-27";
const repo = "example/project";
const source = {
  schema_version: 1,
  mode: "advisory",
  default_class: "project",
  catalog: {
    "tool:node": { class: "toolchain", version: "24.22.3" },
    "tool:python": { class: "toolchain", version: "3.12" },
    "npm:react": { class: "framework", version: null },
  },
  exceptions: [
    {
      repository: repo,
      branch: "dev",
      dependency: "tool:node",
      declaration: "26.13.1",
      reason: "Compatibility test",
      expires_on: date,
    },
  ],
};

test("central version catalog validates and remains advisory", () => {
  const policy = parseDependencyPolicy(
    JSON.parse(readFileSync("policies/dependency-versions.json", "utf8")),
    "fongap-labs"
  );
  assert.equal(policy.mode, "advisory");
  assert.equal(policy.default_class, "project");
  assert.equal(policy.catalog.get("tool:pnpm")?.version, "11.28.5");
  assert.equal(policy.catalog.get("npm:react")?.version, null);
  assert.equal(policy.exceptions.length, 0);
});

test("exact declarations and minor series are compared without claiming range compatibility", () => {
  const policy = parseDependencyPolicy(source, "example");
  assert.equal(evaluateDeclaration(policy, repo, "main", "tool:node", "24.22.3", date), "matching");
  assert.equal(
    evaluateDeclaration(policy, repo, "main", "tool:python", "3.12.1", date),
    "matching"
  );
  assert.equal(
    evaluateDeclaration(policy, repo, "main", "tool:node", ">=24", date),
    "range-review"
  );
  assert.equal(evaluateDeclaration(policy, repo, "main", "npm:react", "19.0.0", date), "observe");
  assert.equal(evaluateDeclaration(policy, repo, "main", "npm:other", "1.0.0", date), "observe");
});

test("exceptions are exact, branch scoped and expire without automatic extension", () => {
  const policy = parseDependencyPolicy(source, "example");
  assert.equal(evaluateDeclaration(policy, repo, "dev", "tool:node", "26.13.1", date), "excepted");
  assert.equal(
    evaluateDeclaration(policy, repo, "main", "tool:node", "26.13.1", date),
    "different"
  );
  assert.equal(
    evaluateDeclaration(policy, repo, "dev", "tool:node", "26.13.1", "2026-11-28"),
    "different"
  );
  assert.equal(
    evaluateDeclaration(policy, "example/other", "dev", "tool:node", "26.13.1", date),
    "different"
  );
  assert.equal(evaluateDeclaration(policy, repo, "dev", "tool:node", "26.13.2", date), "different");
});

test("policy rejects wildcard, duplicate, foreign, malformed and unscoped exceptions", () => {
  const entry = source.exceptions[0]!;
  for (const exceptions of [
    [entry, entry],
    [{ ...entry, repository: "example/*" }],
    [{ ...entry, repository: "other/project" }],
    [{ ...entry, branch: "*" }],
    [{ ...entry, declaration: "*" }],
    [{ ...entry, expires_on: "2026-02-30" }],
    [{ ...entry, reason: "" }],
    [{ ...entry, dependency: "npm:react" }],
  ]) {
    assert.throws(() => parseDependencyPolicy({ ...source, exceptions }, "example"));
  }
  assert.throws(() => parseDependencyPolicy({ ...source, mode: "enforced" }, "example"));
  assert.throws(() =>
    parseDependencyPolicy(
      { ...source, catalog: { "npm:react": { class: "framework", version: "19.0.0" } } },
      "example"
    )
  );
});
