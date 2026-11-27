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

test("central runtime catalog supplies one exact Node version to every project", () => {
  const runtime = parseRuntimeCatalog(policy);
  assert.equal(runtime.node, "26.13.1");
  assert.deepEqual(resolveRuntimeVersions(policy, undefined), {
    ...runtime,
    requires_pnpm: false,
  });
  assert.deepEqual(resolveRuntimeVersions(policy, "pnpm@9.0.0"), {
    ...runtime,
    requires_pnpm: true,
  });
  for (const version of ["", "latest", "26", "26.13.1\nnode=22"]) {
    const invalid = {
      ...policy,
      catalog: {
        ...policy.catalog,
        "tool:node": { class: "toolchain", version },
      },
    };
    assert.throws(() => parseRuntimeCatalog(invalid));
  }
});

test("local runtime plan ignores project version overrides and never executes commands", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-plan-"));
  try {
    writeFileSync(join(root, ".node-version"), "22.0.0\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { install: "exit 1" } })
    );
    assert.deepEqual(readRuntimePlan(root), resolveRuntimeVersions(policy, "pnpm@9.0.0"));
    assert.equal(readRuntimePlan(undefined).node, parseRuntimeCatalog(policy).node);
    assert.equal(readRuntimePlan(root).node, readRuntimePlan(undefined).node);
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

test("central controller workflows use the same runtime catalog after checkout", () => {
  const workflows = [
    "apply-repository-settings",
    "audit-config-scope",
    "authorize-branch-transfer",
    "central-ci-dispatch",
    "ci-follow-up",
    "enroll-organization-repositories",
    "handle-pr-dispatch",
    "handle-pr-review",
    "intake",
    "validate-ci",
  ];
  type Step = {
    id?: string;
    uses?: string;
    run?: string;
    if?: string;
    with?: Record<string, string>;
  };
  for (const name of workflows) {
    const workflow = parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    let setups = 0;
    for (const job of Object.values(workflow.jobs)) {
      const steps = job.steps ?? [];
      for (const [index, step] of steps.entries()) {
        if (!step.uses?.startsWith("actions/setup-node@")) continue;
        setups++;
        const runtime = steps[index - 1];
        assert.equal(runtime?.id, "runtime");
        assert.equal(runtime?.run, "node scripts/resolve-runtime-versions.mjs --github-output .");
        assert.equal(runtime?.if, step.if);
        assert.equal(step.with?.["node-version"], "${{ steps.runtime.outputs.node }}");
        const checkout = steps.findIndex((item) => item.uses?.startsWith("actions/checkout@"));
        assert.ok(checkout >= 0 && checkout < index - 1);
      }
    }
    assert.ok(setups > 0, name);
  }
});
