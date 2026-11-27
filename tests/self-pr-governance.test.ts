import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { validateChange } from "../scripts/validate-change-record.ts";

test("controller PR governance reuses shared validators and blocks merge on failure", async () => {
  const workflow = await readFile(".github/workflows/validate-ci.yml", "utf8");
  const start = workflow.indexOf("  change-governance:");
  const end = workflow.indexOf("  naming:", start);
  assert.ok(start >= 0 && end > start, "controller change-governance job must exist");
  const job = workflow.slice(start, end);

  assert.match(
    workflow,
    /types: \[opened, reopened, synchronize, edited, ready_for_review, converted_to_draft\]/
  );
  assert.match(
    job,
    /ref: \$\{\{ inputs\.dev_head_sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/
  );
  assert.match(job, /Validate PR change record\n\s+if: github\.event_name == 'pull_request'/);
  assert.match(job, /node scripts\/validate-change-record\.ts/);
  assert.match(job, /node scripts\/validate-engineering-language\.ts/);
  assert.match(workflow, /needs:\n\s+- change-governance\n\s+- naming/);
  assert.match(workflow, /CHANGE_GOVERNANCE_RESULT: \$\{\{ needs\.change-governance\.result \}\}/);
  assert.match(workflow, /if \[ "\$CHANGE_GOVERNANCE_RESULT" != "success" \]/);
  assert.match(workflow, /--arg title "\$PR_TITLE"/);
  assert.match(workflow, /\.title == \$title/);
});

test("shared PR validator rejects non-English and invalid controller titles", async () => {
  const root = process.cwd();
  const cases: Array<[string, RegExp]> = [
    ["chore: \u7edf\u4e00 API \u7b49\u5f85", /PR title summary must use English/],
    ["fix: retry \u{1f527}", /PR title summary must use English ASCII/],
    ["docs: update docs", /Unsupported change type/],
    ["missing conventional prefix", /PR title must use type/],
  ];
  for (const [title, reason] of cases) {
    await assert.rejects(
      validateChange(title, "HEAD", "HEAD", root, join(root, "policies")),
      reason
    );
  }
});

test("controller required merge check and write gate reject managed-branch transfers", async () => {
  const workflow = await readFile(".github/workflows/validate-ci.yml", "utf8");
  const gate = workflow.split("  validate-merge:")[1]?.split("  automatic-squash-merge:")[0] ?? "";
  const writer = workflow.split("  automatic-squash-merge:")[1] ?? "";
  assert.match(gate, /PR_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
  assert.match(gate, /PR_HEAD_REF" == "main" \|\| "\$PR_HEAD_REF" == "dev"/);
  assert.match(gate, /Managed branch transfer requires separate human authorization/);
  assert.equal(writer.split('.head.ref != "main" and .head.ref != "dev"').length - 1, 2);
});
