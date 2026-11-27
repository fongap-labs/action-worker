import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  parseRuntimeCatalog,
  readRuntimePlan,
  resolveRuntimeVersions,
} from "../scripts/resolve-runtime-versions.mjs";

const policy = JSON.parse(readFileSync("policies/dependency-versions.json", "utf8"));

test("central runtime catalog preserves the migration baseline without repository routing", () => {
  const runtime = parseRuntimeCatalog(policy);
  assert.deepEqual(resolveRuntimeVersions(policy, undefined, undefined, false), {
    node: runtime.sandboxNode,
    python: runtime.python,
    pnpm: runtime.pnpm,
    requires_pnpm: false,
  });
  assert.equal(resolveRuntimeVersions(policy, undefined, undefined, true).node, runtime.baseline);
  assert.equal(
    resolveRuntimeVersions(policy, "26.13.1\n", "pnpm@11.28.5", false).node,
    "26.13.1"
  );
  assert.equal(
    resolveRuntimeVersions(policy, "26.13.1", "pnpm@11.28.5", false).requires_pnpm,
    true
  );
  for (const version of ["", "latest", "26", "99.1.0", "26.13.1\nnode=22"]) {
    assert.throws(() => resolveRuntimeVersions(policy, version, undefined, false));
  }
});

test("local runtime plan reads the same catalog and never executes manifest commands", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-plan-"));
  try {
    writeFileSync(join(root, ".node-version"), "26.13.1\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.28.5", scripts: { install: "exit 1" } })
    );
    assert.deepEqual(
      readRuntimePlan(root),
      resolveRuntimeVersions(policy, "26.13.1", "pnpm@11.28.5", false)
    );
    assert.equal(readRuntimePlan(undefined).node, parseRuntimeCatalog(policy).baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both sandbox jobs resolve versions after the trusted checkout and before setup", () => {
  const workflow = parse(readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8")) as {
    jobs: Record<
      string,
      { steps: Array<{ id?: string; name?: string; run?: string; with?: Record<string, string> }> }
    >;
  };
  for (const job of ["linux", "windows"]) {
    const steps = workflow.jobs[job]!.steps;
    const checkout = steps.findIndex((step) => step.with?.path === "aw-security");
    const control = steps.findIndex((step) => step.name === "Checkout public trusted CI control");
    const runtime = steps.findIndex((step) => step.id === "runtime");
    const node = steps.findIndex((step) => step.name === "Setup Node");
    assert.ok(checkout >= 0 && control >= 0 && runtime > checkout && runtime > control);
    assert.ok(node > runtime);
    assert.equal(
      steps[runtime]?.run,
      "node aw-security/scripts/resolve-runtime-versions.mjs --github-output ci-control"
    );
    assert.equal(steps[node]?.with?.["node-version"], "${{ steps.runtime.outputs.node }}");
  }
});
