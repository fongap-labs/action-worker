import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseDependencyPolicy } from "../scripts/dependency-version-policy.ts";
import {
  buildNodeProposal,
  discoverProposalTargets,
  publishNodeProposal,
} from "../scripts/propose-dependency-update.ts";

const repo = "fongap-labs/example";
const date = "2026-11-27";
const policy = parseDependencyPolicy(
  JSON.parse(readFileSync("policies/dependency-versions.json", "utf8")),
  "fongap-labs"
);
const target = policy.catalog.get("tool:node")?.version;
const record = "# 更新日志\n\n## [Unreleased]\n\n## [1.0.0]\n";
const manifest = JSON.stringify({ engines: { node: ">=22" }, dependencies: { react: "18.0.0" } });
const lock = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { engines: { node: ">=22" }, dependencies: { react: "18.0.0" } },
    "node_modules/react": { version: "18.0.0", integrity: "sha512-example" },
  },
});

test("batch targets include only active public repositories with existing PR grants", () => {
  const input = {
    full_name: repo,
    private: false,
    archived: false,
    default_branch: "main",
  };
  const result = discoverProposalTargets(
    [
      input,
      { ...input, full_name: "fongap-labs/private", private: true },
      { ...input, full_name: "fongap-labs/archived", archived: true },
      { ...input, full_name: "fongap-labs/ungranted" },
      { ...input, full_name: "fongap-labs/excluded" },
    ],
    {
      [repo]: ["pr"],
      "fongap-labs/private": ["pr"],
      "fongap-labs/archived": ["pr"],
      "fongap-labs/excluded": ["pr"],
    },
    ["fongap-labs/excluded"]
  );
  assert.deepEqual(result, [repo]);
});

test("Node proposals update npm root metadata without altering resolved dependencies", () => {
  const changes = buildNodeProposal(
    policy,
    repo,
    new Map([
      ["package.json", manifest],
      ["package-lock.json", lock],
      [".node-version", "22.0.0\n"],
      ["CHANGELOG.md", record],
    ]),
    date
  );
  const output = new Map(changes.map((change) => [change.path, change.content]));
  assert.equal(output.get(".node-version"), target + "\n");
  const updated = JSON.parse(output.get("package.json") ?? "");
  const updatedLock = JSON.parse(output.get("package-lock.json") ?? "");
  assert.equal(updated.engines.node, target);
  assert.equal(updatedLock.packages[""].engines.node, target);
  assert.deepEqual(updated.dependencies, JSON.parse(manifest).dependencies);
  assert.deepEqual(
    updatedLock.packages["node_modules/react"],
    JSON.parse(lock).packages["node_modules/react"]
  );
  assert.match(output.get("CHANGELOG.md") ?? "", /- 维护:/);
});

test("ambiguous lock managers and missing locks do not receive engine metadata edits", () => {
  for (const extra of [[], [["package-lock.json", lock], ["pnpm-lock.yaml", "lock"]]]) {
    const files = new Map<string, string>([
      ["package.json", manifest],
      ["CHANGELOG.md", record],
    ]);
    for (const pair of extra) {
      files.set(pair[0] ?? "", pair[1] ?? "");
    }
    assert.deepEqual(buildNodeProposal(policy, repo, files, date), []);
  }
});

test("pnpm root engine metadata is updated without modifying the resolved lock", () => {
  const files = new Map([
    [
      "package.json",
      JSON.stringify({ engines: { node: ">=22" }, packageManager: "pnpm@11.28.5" }),
    ],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n"],
    ["CHANGELOG.md", record],
  ]);
  const changes = buildNodeProposal(policy, repo, files, date);
  assert.equal(changes.some((change) => change.path === "pnpm-lock.yaml"), false);
  assert.equal(
    JSON.parse(changes.find((change) => change.path === "package.json")?.content ?? "").engines.node,
    target
  );
});

test("an existing open proposal is reused rather than writing a duplicate branch", async () => {
  const changes = buildNodeProposal(
    policy,
    repo,
    new Map([
      [".node-version", "22.0.0"],
      ["CHANGELOG.md", record],
    ]),
    date
  );
  const result = await publishNodeProposal(
    {
      async get(path) {
        assert.match(path, /pulls\?state=open&base=main/);
        return [
          { number: 42, head: { repo: { full_name: repo }, ref: "chore/dependency-baseline-abc" } },
        ];
      },
    },
    async () => assert.fail("Existing proposal must not trigger a write"),
    repo,
    { sha: "a".repeat(40), tree: "b".repeat(40), files: new Map() },
    changes
  );
  assert.equal(result, 42);
});
