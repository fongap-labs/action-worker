import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseOwnershipPolicy } from "../scripts/central-engineering-gate.ts";
import {
  checkGithubEngineeringOwnership,
  engineeringOwnershipDiffBase,
  inventoryImmutableGitTrees,
  parseCompareFiles,
} from "../scripts/engineering-gate-api.ts";

const policy = parseOwnershipPolicy(
  JSON.parse(readFileSync("policies/engineering-ownership.json", "utf8")) as unknown
);
const privateFixturePolicy = parseOwnershipPolicy({
  ...policy,
  private_workflow_pins: [
    {
      repository: "fongap-labs/private-fixture",
      path: ".github/workflows/private-release-build.yml",
      blob_sha: "c".repeat(40),
      reason: "Test-only reviewed blob for private workflow boundary verification.",
    },
  ],
});
const base = "a".repeat(40);
const head = "b".repeat(40);
const compare = (files: unknown[]) => ({
  base_commit: { sha: base },
  // Exact GitHub REST compare response: there is no head_commit field.
  commits: [{ sha: head }],
  total_commits: 1,
  files,
});
const templatePath = "templates/bridge/dispatch-central-ci.yml";

test("comparison parser rejects incomplete inventories and treats renamed tests as additions", () => {
  assert.deepEqual(
    parseCompareFiles(
      compare([
        { filename: "tests/old.test.ts", status: "renamed" },
        { filename: "src/index.ts", status: "modified" },
        { filename: "src/deleted.ts", status: "removed" },
      ])
    ),
    [
      { status: "A", path: "tests/old.test.ts" },
      { status: "M", path: "src/index.ts" },
      { status: "D", path: "src/deleted.ts" },
    ]
  );
  assert.throws(
    () => parseCompareFiles({ files: Array(300).fill({ filename: "x", status: "added" }) }),
    /file limit/
  );
  assert.throws(
    () => parseCompareFiles({ files: [{ status: "unknown", filename: "a" }] }),
    /unsupported/
  );
  assert.throws(() => parseCompareFiles({}), /file inventory/);
});

test("compare revision identity accepts GitHub REST commits but rejects incomplete snapshots", async () => {
  const files = [{ filename: "src/index.ts", status: "modified" }];
  const get = (payload: unknown) => async () => payload;
  await assert.doesNotReject(
    checkGithubEngineeringOwnership(
      "fongap-labs/ai-gateway",
      base,
      head,
      policy,
      get(compare(files)),
      (path) => readFileSync(path, "utf8")
    )
  );
  for (const invalid of [
    { ...compare(files), base_commit: { sha: head } },
    { ...compare(files), commits: [{ sha: base }] },
    { ...compare(files), commits: [] },
    { ...compare(files), total_commits: 2 },
    { ...compare(files), head_commit: { sha: base } },
    { ...compare(files), commits: Array(251).fill({ sha: head }), total_commits: 251 },
  ]) {
    await assert.rejects(
      checkGithubEngineeringOwnership(
        "fongap-labs/ai-gateway",
        base,
        head,
        policy,
        get(invalid),
        (path) => readFileSync(path, "utf8")
      ),
      /immutable CI revision/
    );
  }
});

test("privileged API gate blocks new tests without checking out private source", async () => {
  const requested: string[] = [];
  await assert.rejects(
    checkGithubEngineeringOwnership(
      "fongap-labs/mcp-hub",
      base,
      head,
      policy,
      async (path) => {
        requested.push(path);
        return compare([{ filename: "tests/new-feature.test.js", status: "added" }]);
      },
      (path) => readFileSync(path, "utf8")
    ),
    /new-local-test/
  );
  assert.deepEqual(requested, ["repos/fongap-labs/mcp-hub/compare/" + base + "..." + head]);
});

test("privileged API gate permits only exact centrally approved workflow templates", async () => {
  const source = readFileSync(templatePath, "utf8");
  const entries = [{ filename: ".github/workflows/ci.yml", status: "modified" }];
  const reads: string[] = [];
  await checkGithubEngineeringOwnership(
    "fongap-labs/ai-gateway",
    base,
    head,
    policy,
    async (path) => {
      reads.push(path);
      return path.includes("/compare/")
        ? compare(entries)
        : { encoding: "base64", content: Buffer.from(source).toString("base64") };
    },
    (path) => readFileSync(path, "utf8")
  );
  assert.equal(reads.length, 2);
  assert.match(reads[1] ?? "", /contents\/\.github\/workflows\/ci\.yml\?ref=/);
  await assert.rejects(
    checkGithubEngineeringOwnership(
      "fongap-labs/ai-gateway",
      base,
      head,
      policy,
      async (path) =>
        path.includes("/compare/")
          ? compare(entries)
          : { encoding: "base64", content: Buffer.from("modified").toString("base64") },
      (path) => readFileSync(path, "utf8")
    ),
    /workflow-template-mismatch/
  );
});

test("private workflow ownership checks commit-bound blobs without downloading private source", async () => {
  const pin = privateFixturePolicy.private_workflow_pins[0];
  assert.ok(pin);
  const calls: string[] = [];
  const fetch = async (path: string) => {
    calls.push(path);
    if (path.includes("/compare/")) {
      return compare([{ filename: pin.path, status: "modified", sha: pin.blob_sha }]);
    }
    throw new Error("Private source file must never be downloaded by the public control gate.");
  };
  await checkGithubEngineeringOwnership(
    pin.repository,
    base,
    head,
    privateFixturePolicy,
    fetch,
    () => {
      throw new Error("Private workflow must not become a public template.");
    }
  );
  assert.deepEqual(calls, ["repos/" + pin.repository + "/compare/" + base + "..." + head]);
  for (const sha of [undefined, "b".repeat(40)]) {
    await assert.rejects(
      checkGithubEngineeringOwnership(
        pin.repository,
        base,
        head,
        privateFixturePolicy,
        async () => compare([{ filename: pin.path, status: "modified", ...(sha ? { sha } : {}) }]),
        () => {
          throw new Error("Untrusted private workflow read.");
        }
      ),
      /private-workflow-blob-mismatch/
    );
  }
  await assert.rejects(
    checkGithubEngineeringOwnership(
      "fongap-labs/dsh-plugin",
      base,
      head,
      privateFixturePolicy,
      async () => compare([{ filename: pin.path, status: "modified", sha: pin.blob_sha }]),
      () => {
        throw new Error("No cross-repository template read.");
      }
    ),
    /workflow-outside-control/
  );
});

test("privileged CI blocks deleting central workflow and manifest even without source checkout", async () => {
  for (const pathname of [".github/workflows/ci.yml", ".github/execution-manifest.json"]) {
    const requests: string[] = [];
    await assert.rejects(
      checkGithubEngineeringOwnership(
        "fongap-labs/dsh-plugin",
        base,
        head,
        policy,
        async (path) => {
          requests.push(path);
          return compare([{ filename: pathname, status: "removed" }]);
        },
        (path) => readFileSync(path, "utf8")
      ),
      /(?:required-workflow-deleted|execution-manifest-deleted)/
    );
    assert.deepEqual(requests, ["repos/fongap-labs/dsh-plugin/compare/" + base + "..." + head]);
  }
});

test("control repo is exempt; invalid input fails closed", async () => {
  await checkGithubEngineeringOwnership(
    "fongap-labs/action-worker",
    base,
    head,
    policy,
    async () => {
      throw new Error("Control repo must not query itself.");
    },
    (path) => readFileSync(path, "utf8")
  );
  await assert.rejects(
    checkGithubEngineeringOwnership(
      "outside/example",
      base,
      head,
      policy,
      async () => compare([]),
      (path) => readFileSync(path, "utf8")
    ),
    /Invalid immutable/
  );
});

test("central preparation gate covers Linux and native-private CI before dispatch", () => {
  const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
  const position = workflow.indexOf(
    "- name: Enforce central engineering ownership before CI routing"
  );
  assert.ok(position > workflow.indexOf("- name: Validate requested revision"));
  assert.ok(position < workflow.indexOf("native-private-pilot:"));
  assert.ok(position < workflow.indexOf("linux:"));
  assert.match(workflow, /node scripts\/engineering-gate-api\.ts/);
});

test("only the pinned Delta import uses the trusted upstream tree", () => {
  const bootstrap = "7556dc8dfede03053e35359f2b55dd299da1f3ee";
  const upstream = "2e39e70496aa02986ca6a820c5d497e816b69d7e";
  assert.equal(engineeringOwnershipDiffBase("fongap-labs/delta", bootstrap), upstream);
  assert.equal(engineeringOwnershipDiffBase("fongap-labs/delta", head), head);
  assert.equal(engineeringOwnershipDiffBase("fongap-labs/mcp-hub", bootstrap), bootstrap);
});

test("full Git inventory detects changes and also unchanged active workflows", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-ownership-full-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Governance fixture");
    git("config", "user.email", "test.invalid");
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "tests", "inherited.test.ts"), "test('old', () => {});\n");
    writeFileSync(join(root, ".github", "workflows", "own.yml"), "name: Untrusted\n");
    git("add", "-A");
    git("commit", "-m", "upstream");
    const previous = git("rev-parse", "HEAD");

    writeFileSync(join(root, "tests", "custom.test.ts"), "test('new', () => {});\n");
    git("add", "-A");
    git("commit", "-m", "custom");
    const current = git("rev-parse", "HEAD");
    const inventory = await inventoryImmutableGitTrees(root, previous, current);
    assert.deepEqual(inventory, [
      { status: "A", path: "tests/custom.test.ts" },
      { status: "A", path: ".github/workflows/own.yml" },
    ]);
    await assert.rejects(
      inventoryImmutableGitTrees(root, "0".repeat(40), current),
      /fatal|unknown|invalid|Needed a single revision/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large public comparison reads complete pinned trees; private remains fail closed", async () => {
  const template = readFileSync("templates/bridge/notify-action-worker.yml", "utf8");
  const calls: string[] = [];
  const mockDiff = async (repo: string, comparisonBase: string, revision: string) => {
    calls.push(repo + "@" + comparisonBase + "..." + revision);
    return [
      { status: "A" as const, path: "src/delta-entry.ts" },
      { status: "A" as const, path: ".github/workflows/notify-action-worker.yml" },
    ];
  };
  await checkGithubEngineeringOwnership(
    "fongap-labs/delta",
    "7556dc8dfede03053e35359f2b55dd299da1f3ee",
    head,
    policy,
    async (path) => {
      assert.match(path, /\/contents\/\.github\/workflows\/notify-action-worker.yml\?ref=/);
      return { encoding: "base64", content: Buffer.from(template).toString("base64") };
    },
    (path) => readFileSync(path, "utf8"),
    mockDiff,
    true
  );
  assert.deepEqual(calls, ["fongap-labs/delta@2e39e70496aa02986ca6a820c5d497e816b69d7e..." + head]);
  await assert.rejects(
    checkGithubEngineeringOwnership(
      "fongap-labs/delta",
      "7556dc8dfede03053e35359f2b55dd299da1f3ee",
      head,
      policy,
      async () => {
        throw new Error("Private source must not be fetched");
      },
      (path) => readFileSync(path, "utf8"),
      mockDiff,
      false
    ),
    /verified public target/
  );
  const large = compare(
    Array.from({ length: 300 }, (_, i) => ({
      filename: "src/file-" + i + ".ts",
      status: "added",
    }))
  );
  await checkGithubEngineeringOwnership(
    "fongap-labs/mcp-hub",
    base,
    head,
    policy,
    async () => large,
    (path) => readFileSync(path, "utf8"),
    async (repo, comparisonBase, revision) => {
      assert.equal(repo, "fongap-labs/mcp-hub");
      assert.equal(comparisonBase, base);
      assert.equal(revision, head);
      return [{ status: "M", path: "src/existing.ts" }];
    },
    true
  );
  await assert.rejects(
    checkGithubEngineeringOwnership(
      "fongap-labs/mcp-hub",
      base,
      head,
      policy,
      async () => large,
      (path) => readFileSync(path, "utf8"),
      mockDiff,
      false
    ),
    /private inventory file limit/
  );
});
