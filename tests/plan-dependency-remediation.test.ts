import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDependencyPolicy } from "../scripts/dependency-version-policy.ts";
import { planDependencyRemediation } from "../scripts/plan-dependency-remediation.ts";

const sha = "a".repeat(40);
const blob = "b".repeat(40);
const date = "2026-11-27";
const repo = "example/project";
const policy = parseDependencyPolicy(
  {
    schema_version: 1,
    mode: "advisory",
    default_class: "project",
    catalog: {
      "tool:node": { class: "toolchain", version: "26.13.1" },
      "tool:pnpm": { class: "toolchain", version: "11.28.5" },
      "npm:typescript": { class: "engineering", version: "7.0.2" },
      "npm:react": { class: "framework", version: null },
    },
    exceptions: [
      {
        repository: repo,
        branch: "dev",
        dependency: "tool:node",
        declaration: "22.0.0",
        reason: "Temporary compatibility review",
        expires_on: date,
      },
    ],
  },
  "example"
);

function declaration(path: string, key: string, version: string) {
  return { path, key, version, blob_sha: blob };
}

test("remediation plans bind file locations and branch snapshots without writing", () => {
  const input = [
    declaration(".node-version", "tool:node", "22.0.0"),
    declaration("packages/app/package.json", "tool:node", ">=22"),
    declaration("packages/app/package.json", "npm:typescript", "6.0.3"),
    declaration("packages/app/package.json", "npm:react", "18.0.0"),
    declaration("packages/app/package.json", "npm:typescript", "^6.0.3"),
  ];
  const main = planDependencyRemediation(
    policy,
    repo,
    "main",
    sha,
    input,
    ["pnpm-lock.yaml"],
    date
  );
  assert.equal(main.base_sha, sha);
  assert.equal(main.automatic_writes, false);
  assert.deepEqual(
    main.changes.map((item) => [item.strategy, item.target_version, item.lock_path]),
    [
      ["declaration-only", "26.13.1", null],
      ["pnpm-lock", "26.13.1", "pnpm-lock.yaml"],
      ["pnpm-lock", "7.0.2", "pnpm-lock.yaml"],
      ["manual-review", "7.0.2", null],
    ]
  );
  assert.equal(main.changes[0]?.blob_sha, blob);
  const dev = planDependencyRemediation(policy, repo, "dev", sha, input, ["pnpm-lock.yaml"], date);
  assert.equal(dev.branch, "dev");
  assert.equal(dev.changes.length, main.changes.length - 1);
  assert.throws(() => planDependencyRemediation(policy, repo, "main", "", input, [], date));
});

test("ambiguous or absent lock files never receive an executable repair strategy", () => {
  const input = [declaration("apps/a/package.json", "npm:typescript", "6.0.3")];
  for (const locks of [
    [],
    ["yarn.lock"],
    ["pnpm-lock.yaml", "package-lock.json"],
    ["apps/a/yarn.lock", "pnpm-lock.yaml"],
  ]) {
    const plan = planDependencyRemediation(policy, repo, "main", sha, input, locks, date);
    assert.equal(plan.changes[0]?.strategy, "manual-review");
  }
  const plan = planDependencyRemediation(
    policy,
    repo,
    "main",
    sha,
    [...input, ...input],
    ["apps/package-lock.json", "pnpm-lock.yaml"],
    date
  );
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0]?.strategy, "npm-lock");
  assert.equal(plan.changes[0]?.lock_path, "apps/package-lock.json");
});
