import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ChangedFile,
  centralOwnershipComparisonBase,
  inspectEngineeringOwnership,
  isPinnedPluginRenameCandidate,
  PLUGIN_RENAME_BASES,
  parseChangedFiles,
  parseOwnershipPolicy,
  runOwnershipGate,
} from "../scripts/central-engineering-gate.ts";

const policy = parseOwnershipPolicy(
  JSON.parse(readFileSync("policies/engineering-ownership.json", "utf8")) as unknown
);
const pinnedPolicy = parseOwnershipPolicy({
  ...policy,
  private_workflow_pins: [
    {
      repository: "fongap-labs/private-fixture",
      path: ".github/workflows/private-release-build.yml",
      blob_sha: "b".repeat(40),
      reason: "Test-only reviewed blob used to verify exact workflow pinning.",
    },
  ],
});
const ciPath = ".github/workflows/ci.yml";
const notifyPath = ".github/workflows/notify-action-worker.yml";
const ciTemplate = readFileSync("templates/bridge/dispatch-central-ci.yml", "utf8");
const notifyTemplate = readFileSync("templates/bridge/notify-action-worker.yml", "utf8");
const files = new Map([
  [ciPath, ciTemplate],
  [notifyPath, notifyTemplate],
]);
const readFile = (path: string) => files.get(path) ?? "";
const template = (path: string) => readFileSync(path, "utf8");
const inspect = (repository: string, changes: ChangedFile[]) =>
  inspectEngineeringOwnership(policy, repository, changes, readFile, template);
const inspectPinned = (repository: string, changes: ChangedFile[]) =>
  inspectEngineeringOwnership(pinnedPolicy, repository, changes, readFile, template);

test("central ownership policy rejects malformed, duplicate and insufficiently justified exceptions", () => {
  assert.equal(policy.control_repository, "fongap-labs/action-worker");
  assert.throws(() => parseOwnershipPolicy({ ...policy, schema_version: 2 }));
  assert.throws(
    () =>
      parseOwnershipPolicy({
        ...policy,
        local_test_exceptions: [...policy.local_test_exceptions, policy.local_test_exceptions[0]],
      }),
    /Duplicate/
  );
  assert.throws(
    () =>
      parseOwnershipPolicy({
        ...policy,
        local_test_exceptions: [
          {
            repository: "fongap-labs/delta",
            path_prefix: "../tests/",
            reason: "Must not allow unsafe path traversal.",
          },
        ],
      }),
    /Invalid/
  );
});

test("new project-local tests are rejected, while unchanged historical suites can be modified", () => {
  const findings = inspect("fongap-labs/plugins", [
    { status: "A", path: "tests/new-feature.test.mjs" },
    { status: "A", path: "packages/dsh-delta-code/src/new.spec.ts" },
    { status: "A", path: "tests/helpers/fixture.js" },
    { status: "M", path: "tests/existing-feature.test.mjs" },
  ]);
  assert.deepEqual(
    findings.map((f) => f.code),
    ["new-local-test", "new-local-test", "new-local-test"]
  );
  assert.deepEqual(
    inspect("fongap-labs/mcp-hub", [
      { status: "A", path: "src/test_helpers.py" },
      { status: "A", path: "tests/auth.test.js" },
    ]).map((x) => x.code),
    ["new-local-test", "new-local-test"]
  );
});

test("central exceptions apply only to the specified repository and subtree", () => {
  assert.deepEqual(
    inspect("fongap-labs/app-source", [
      { status: "A", path: "projects/SecurePigeon/crates/core/tests/check.rs" },
    ]),
    []
  );
  assert.deepEqual(
    inspect("fongap-labs/delta-suite", [
      { status: "A", path: "tests/foundation_runtime_e2e/test_engine.py" },
    ]),
    []
  );
  assert.deepEqual(
    inspect("fongap-labs/plugins", [
      { status: "A", path: "projects/SecurePigeon/crates/core/tests/check.rs" },
    ]).map((x) => x.code),
    ["new-local-test"]
  );
  assert.deepEqual(
    inspect("fongap-labs/action-worker", [{ status: "A", path: "tests/new-control.test.ts" }]),
    []
  );
});

test("workflow changes must be byte-exact approved central templates", () => {
  assert.deepEqual(
    inspect("fongap-labs/ai-gateway", [
      { status: "M", path: ciPath },
      { status: "A", path: notifyPath },
    ]),
    []
  );
  assert.deepEqual(
    inspect("fongap-labs/ai-gateway", [
      { status: "A", path: ".github/workflows/own-ci.yml" },
      { status: "M", path: ".github/workflows/custom-build.yml" },
    ]).map((f) => f.code),
    ["workflow-outside-control", "workflow-outside-control"]
  );
  const changedContent = (path: string) =>
    path === ciPath ? ciTemplate + "\n# extra" : readFile(path);
  assert.deepEqual(
    inspectEngineeringOwnership(
      policy,
      "fongap-labs/ai-gateway",
      [{ status: "M", path: ciPath }],
      changedContent,
      template
    ).map((f) => f.code),
    ["workflow-template-mismatch"]
  );
});

test("private source workflow pins require an exact reviewed blob and never accept plain templates", () => {
  const pin = pinnedPolicy.private_workflow_pins[0];
  assert.ok(pin);
  assert.deepEqual(policy.private_workflow_pins, []);
  const accepted = [{ status: "M" as const, path: pin.path, sha: pin.blob_sha }];
  assert.deepEqual(inspectPinned(pin.repository, accepted), []);
  assert.deepEqual(
    inspectPinned(pin.repository, [{ status: "M", path: pin.path, sha: "a".repeat(40) }]).map(
      (x) => x.code
    ),
    ["private-workflow-blob-mismatch"]
  );
  assert.deepEqual(
    inspectPinned(pin.repository, [{ status: "M", path: pin.path }]).map((x) => x.code),
    ["private-workflow-blob-mismatch"]
  );
  assert.deepEqual(
    inspectPinned(pin.repository, [{ status: "A", path: pin.path, sha: pin.blob_sha }]).map(
      (x) => x.code
    ),
    ["private-workflow-blob-mismatch"]
  );
  assert.deepEqual(
    inspectPinned("fongap-labs/mcp-hub", accepted).map((x) => x.code),
    ["workflow-outside-control"]
  );
  assert.deepEqual(
    inspectPinned(pin.repository, [{ status: "D", path: pin.path }]).map((x) => x.code),
    ["required-workflow-deleted"]
  );
  assert.deepEqual(
    inspectPinned(pin.repository, [
      { status: "A", path: ".github/workflows/private-release-bypass.yml" },
    ]).map((x) => x.code),
    ["workflow-outside-control"]
  );
});

test("private workflow pins reject duplicate, invalid and overlapping ownership", () => {
  const pin = pinnedPolicy.private_workflow_pins[0];
  assert.ok(pin);
  assert.throws(
    () => parseOwnershipPolicy({ ...policy, private_workflow_pins: [pin, pin] }),
    /Duplicate private workflow blob pin/
  );
  assert.throws(
    () =>
      parseOwnershipPolicy({
        ...policy,
        private_workflow_pins: [{ ...pin, blob_sha: "not-a-git-blob" }],
      }),
    /Invalid private workflow blob pin/
  );
  assert.throws(
    () =>
      parseOwnershipPolicy({
        ...policy,
        private_workflow_pins: [{ ...pin, path: ".github/workflows/ci.yml" }],
      }),
    /Invalid private workflow blob pin/
  );
  assert.throws(
    () =>
      parseOwnershipPolicy({
        ...policy,
        private_workflow_pins: [{ ...pin, path: ".github/../secret.yml" }],
      }),
    /Invalid private workflow blob pin/
  );
  assert.throws(
    () =>
      parseOwnershipPolicy({
        ...policy,
        private_workflow_pins: [{ ...pin, repository: policy.control_repository }],
      }),
    /Invalid private workflow blob pin/
  );
  assert.throws(
    () => parseOwnershipPolicy({ ...policy, private_workflow_pins: undefined }),
    /Invalid central engineering ownership policy/
  );
});

test("adding a separate CI runner is blocked, project-specific configs remain permitted", () => {
  assert.deepEqual(
    inspect("fongap-labs/mcp-hub", [
      { status: "A", path: ".github/scripts/central-ci.sh" },
      { status: "A", path: "scripts/central-ci-windows.mjs" },
      { status: "A", path: "scripts/build-release.mjs" },
      { status: "A", path: "scripts/check-gateway.mjs" },
      { status: "A", path: "tsconfig.json" },
      { status: "A", path: "packages/desktop/build-config.json" },
    ]).map((f) => f.code),
    ["new-local-ci-runner", "new-local-ci-runner", "new-local-ci-runner", "new-local-ci-runner"]
  );
});

test("changes to legacy CI control and deletion of mandatory workflow cannot bypass the gate", () => {
  assert.deepEqual(
    inspect("fongap-labs/plugins", [
      { status: "M", path: ".github/scripts/central-ci.sh" },
      { status: "D", path: ciPath },
      { status: "D", path: notifyPath },
      { status: "D", path: ".github/execution-manifest.json" },
      { status: "D", path: ".github/workflows/legacy-local-build.yml" },
    ]).map((f) => f.code),
    [
      "project-owned-ci-control-modified",
      "required-workflow-deleted",
      "required-workflow-deleted",
      "execution-manifest-deleted",
    ]
  );
});

test("git change parser fails closed on invalid, truncated or ambiguous records", () => {
  assert.deepEqual(parseChangedFiles("A\0tests/new.test.mjs\0M\0src/index.ts\0"), [
    { status: "A", path: "tests/new.test.mjs" },
    { status: "M", path: "src/index.ts" },
  ]);
  assert.deepEqual(parseChangedFiles("D\0.github/workflows/ci.yml\0"), [
    { status: "D", path: ".github/workflows/ci.yml" },
  ]);
  assert.deepEqual(parseChangedFiles(""), []);
  assert.throws(() => parseChangedFiles("A\0src/x"), /incomplete/);
  assert.throws(() => parseChangedFiles("X\0src/x\0"), /invalid/);
  assert.throws(
    () => inspect("fongap-labs/mcp-hub", [{ status: "A", path: "tests/../src/bypass.test.ts" }]),
    /Invalid git change/
  );
});

test("real git rename into a local tests directory is not mistaken for an allowed modification", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-engineering-gate-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Governance test");
    git("config", "user.email", "governance.invalid");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "sample.mjs"), "export default 1;\n");
    git("add", ".");
    git("commit", "-m", "baseline");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(root, "tests"), { recursive: true });
    git("mv", "docs/sample.mjs", "tests/new.test.mjs");
    git("commit", "-m", "move into local suite");
    const head = git("rev-parse", "HEAD");
    assert.throws(
      () => runOwnershipGate(root, base, head, "fongap-labs/mcp-hub"),
      /new-local-test/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux central sandbox runs trusted ownership policy before project-controlled CI", () => {
  const workflow = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");
  const policyStep = workflow.indexOf("- name: Enforce central engineering ownership");
  const ciStep = workflow.indexOf("- name: Run trusted Linux CI");
  assert.ok(policyStep > workflow.indexOf("- name: Checkout current central security scanner"));
  assert.ok(policyStep < ciStep);
  assert.match(workflow, /node aw-security\/scripts\/central-engineering-gate\.ts/);
  assert.match(workflow, /POLICY_BASE_SHA: \$\{\{ inputs\.diff_base_sha \}\}/);
  assert.match(workflow, /POLICY_HEAD_SHA: \$\{\{ inputs\.head_sha \}\}/);
});

test("Delta desktop builder compiles referenced libraries before package-local TypeScript", () => {
  const build = readFileSync("tests/packs/delta/desktop-build-ci.sh", "utf8");
  const install = build.indexOf("pnpm install --frozen-lockfile");
  const references = build.indexOf("pnpm run build:lib:host");
  assert.equal(build.includes("pnpm run build:lib\n"), false);
  const desktop = build.indexOf("pnpm run build:desktop");
  assert.ok(install > 0);
  assert.ok(references > install);
  assert.ok(desktop > references);
});

test("the local ownership gate pins Delta initial import, never ordinary PRs", () => {
  const bootstrap = "7556dc8dfede03053e35359f2b55dd299da1f3ee";
  const upstream = "2e39e70496aa02986ca6a820c5d497e816b69d7e";
  assert.equal(centralOwnershipComparisonBase("fongap-labs/delta", bootstrap), upstream);
  assert.equal(centralOwnershipComparisonBase("fongap-labs/delta", upstream), upstream);
  assert.equal(centralOwnershipComparisonBase("fongap-labs/app-source", bootstrap), bootstrap);
});

test("plugin rename proof candidates are limited to existing paths and the two CI controls", () => {
  const allowed = [
    { status: "A" as const, path: "tests/delta-code-routing.test.mjs" },
    { status: "A" as const, path: "tests/delta-suite-native.test.mjs" },
    { status: "M" as const, path: ".github/scripts/central-ci.sh" },
    { status: "M" as const, path: "scripts/central-ci-windows.mjs" },
  ];
  const blocked = [
    { status: "A" as const, path: "tests/new-feature.test.mjs" },
    { status: "A" as const, path: "scripts/central-ci-windows.mjs" },
    { status: "M" as const, path: "tests/delta-code-routing.test.mjs" },
    { status: "A" as const, path: "tests/delta-other.test.mjs" },
  ];
  assert.ok(allowed.every(isPinnedPluginRenameCandidate));
  assert.ok(blocked.every((item) => !isPinnedPluginRenameCandidate(item)));
});

test("plugin rename allowance pins only the two verified main baselines", () => {
  assert.deepEqual(
    [...PLUGIN_RENAME_BASES],
    ["f6f265ae211cfa99830d214c3fba3319e5a5ce1c", "094ad41c4948155419eb12a53be6709d88272c3d"]
  );
  assert.equal(PLUGIN_RENAME_BASES.has("0".repeat(40)), false);
});
