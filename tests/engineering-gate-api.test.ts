import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseOwnershipPolicy } from "../scripts/central-engineering-gate.ts";
import {
  checkGithubEngineeringOwnership,
  comparePinnedFileTrees,
  parseCompareFiles,
} from "../scripts/engineering-gate-api.ts";
import { pinnedInitialImportUpstream } from "../scripts/validate-engineering-language.ts";

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

test("pinned Delta first-import uses complete immutable Git trees and keeps local test bans", async () => {
  const bootstrap = "7556dc8dfede03053e35359f2b55dd299da1f3ee";
  const upstream = pinnedInitialImportUpstream("fongap-labs/delta", bootstrap);
  assert.ok(upstream);
  assert.equal(pinnedInitialImportUpstream("fongap-labs/ai-gateway", bootstrap), null);
  assert.equal(pinnedInitialImportUpstream("fongap-labs/delta", base), null);

  const upstreamTreeSha = "c".repeat(40);
  const headTreeSha = "d".repeat(40);
  const blob = "e".repeat(40);
  const upstreamTree = {
    sha: upstreamTreeSha,
    truncated: false,
    tree: [{ path: "src/index.ts", type: "blob", mode: "100644", sha: blob }],
  };
  const headTree = {
    sha: headTreeSha,
    truncated: false,
    tree: [
      { path: "src/index.ts", type: "blob", mode: "100644", sha: blob },
      { path: "docs/change.md", type: "blob", mode: "100644", sha: "f".repeat(40) },
    ],
  };
  const requested: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    requested.push(path);
    if (path.endsWith("/git/commits/" + upstream)) {
      return { sha: upstream, tree: { sha: upstreamTreeSha } };
    }
    if (path.endsWith("/git/commits/" + head)) {
      return { sha: head, tree: { sha: headTreeSha } };
    }
    if (path.endsWith("/git/trees/" + upstreamTreeSha + "?recursive=1")) return upstreamTree;
    if (path.endsWith("/git/trees/" + headTreeSha + "?recursive=1")) return headTree;
    throw new Error("Unexpected Git API access: " + path);
  };
  assert.deepEqual(await comparePinnedFileTrees("fongap-labs/delta", upstream, head, get), [
    { status: "A", path: "docs/change.md", sha: "f".repeat(40) },
  ]);
  assert.equal(requested.length, 4);
  requested.length = 0;
  await checkGithubEngineeringOwnership("fongap-labs/delta", bootstrap, head, policy, get, (path) =>
    readFileSync(path, "utf8")
  );
  assert.equal(requested.length, 4);
  assert.ok(requested.every((path) => !path.includes("/compare/")));

  await assert.rejects(
    comparePinnedFileTrees("fongap-labs/delta", upstream, head, async (path) =>
      path.includes("/commits/")
        ? path.endsWith(upstream)
          ? { sha: upstream, tree: { sha: upstreamTreeSha } }
          : { sha: head, tree: { sha: headTreeSha } }
        : {
            ...headTree,
            sha: path.includes(upstreamTreeSha) ? upstreamTreeSha : headTreeSha,
            truncated: true,
          }
    ),
    /incomplete/
  );
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
