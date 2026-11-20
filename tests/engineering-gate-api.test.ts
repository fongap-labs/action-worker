import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseOwnershipPolicy } from "../scripts/central-engineering-gate.ts";
import {
  checkGithubEngineeringOwnership,
  parseCompareFiles,
} from "../scripts/engineering-gate-api.ts";

const policy = parseOwnershipPolicy(
  JSON.parse(readFileSync("policies/engineering-ownership.json", "utf8")) as unknown
);
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
        "fongap-labs/ai-gateway", base, head, policy,
        get(invalid), (path) => readFileSync(path, "utf8")
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
