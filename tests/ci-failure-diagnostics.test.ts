import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  classifyFailure,
  markdownFailureSummary,
  summarizeFailures,
} from "../scripts/diagnose-ci-failure.ts";

test("failed CI steps are classified without treating the aggregate gate as the root cause", () => {
  const findings = summarizeFailures([
    {
      name: "validate-merge",
      conclusion: "failure",
      steps: [{ name: "Aggregate merge gate", conclusion: "failure" }],
    },
    {
      name: "Security checks",
      conclusion: "failure",
      steps: [{ name: "Validate security gate", conclusion: "failure" }],
    },
    {
      name: "Static analysis",
      conclusion: "failure",
      steps: [{ name: "Lint with Biome", conclusion: "failure" }],
    },
    {
      name: "Main CI",
      conclusion: "failure",
      steps: [{ name: "Mint PR status write token", conclusion: "failure" }],
    },
  ]);
  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.severity]),
    [
      ["security", "high"],
      ["authorization", "high"],
      ["code", "medium"],
    ]
  );
});

test("transient infrastructure failures do not receive a bypass recommendation", () => {
  assert.equal(classifyFailure("Linux CI", "Install dependencies").kind, "infrastructure");
  assert.equal(classifyFailure("New job", "Unrecognized phase").kind, "unknown");
  assert.deepEqual(summarizeFailures([{ name: "Skipped", conclusion: "skipped" }]), []);
});

test("CI diagnostics avoid duplicated alerts and mask unsafe markdown delimiters", () => {
  const summary = markdownFailureSummary(
    [classifyFailure("job | secret", "Unsafe\nstep")],
    "fongap-labs/action-worker",
    "123"
  );
  assert.match(summary, /actions\/runs\/123/);
  assert.doesNotMatch(summary, /Unsafe\nstep/);
  assert.match(summary, /cannot override the merge gate/);
});

test("the existing merge gate remains mandatory and diagnostics run only after a failure", async () => {
  const workflow = await readFile(".github/workflows/validate-ci.yml", "utf8");
  assert.match(workflow, /- name: Aggregate merge gate/);
  assert.match(workflow, /- name: Classify failed steps\n\s+if: failure\(\)/);
  assert.match(workflow, /run: node scripts\/diagnose-ci-failure\.ts/);
  assert.match(workflow, /actions: read/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});
