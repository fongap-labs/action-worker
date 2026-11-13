import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isGeneratedMetricsOnlyChange } from "../scripts/metrics-changelog-exemption.ts";
import { renderMetrics } from "../scripts/update-work-metrics.ts";

const repository = "fongap-labs/action-worker";
const title = "chore(metrics): update work metrics";
const baseReadme = `# Action Worker

An unchanged introduction.

<!-- work-metrics:start -->
legacy badge content
<!-- work-metrics:end -->

The rest of the README is protected.
`;
const headReadme = renderMetrics(
  baseReadme,
  { dispatch: 149, pr_governance: 1720, ai_review: 118, gate: 1720, release_governance: 70 },
  repository
);
const valid = { title, repository, changedPaths: ["README.md"], baseReadme, headReadme };

test("only a canonical action-worker README metrics update avoids CHANGELOG churn", () => {
  assert.equal(isGeneratedMetricsOnlyChange(valid), true);
  assert.equal(isGeneratedMetricsOnlyChange({ ...valid, title: "chore: update work metrics" }), false);
  assert.equal(isGeneratedMetricsOnlyChange({ ...valid, title: "fix(metrics): update work metrics" }), false);
  assert.equal(
    isGeneratedMetricsOnlyChange({ ...valid, repository: "fongap-labs/ai-gateway" }),
    false
  );
  assert.equal(
    isGeneratedMetricsOnlyChange({ ...valid, changedPaths: ["README.md", "src/index.ts"] }),
    false
  );
  assert.equal(isGeneratedMetricsOnlyChange({ ...valid, changedPaths: ["CHANGELOG.md"] }), false);
  assert.equal(isGeneratedMetricsOnlyChange({ ...valid, headReadme: baseReadme }), false);
});

test("badge-only exemption cannot mask arbitrary README edits or malformed badges", () => {
  assert.equal(
    isGeneratedMetricsOnlyChange({
      ...valid,
      headReadme: headReadme.replace("An unchanged introduction.", "An edited introduction."),
    }),
    false
  );
  assert.equal(
    isGeneratedMetricsOnlyChange({
      ...valid,
      headReadme: headReadme.replace("The rest of the README is protected.", "A malicious change."),
    }),
    false
  );
  assert.equal(
    isGeneratedMetricsOnlyChange({
      ...valid,
      headReadme: headReadme.replace("img.shields.io", "attacker.invalid"),
    }),
    false
  );
  assert.equal(
    isGeneratedMetricsOnlyChange({
      ...valid,
      headReadme: headReadme.replace("Task%20Dispatch-149", "Task%20Dispatch-99999999999999999999"),
    }),
    false
  );
  assert.equal(
    isGeneratedMetricsOnlyChange({
      ...valid,
      headReadme: headReadme + "\n<!-- work-metrics:start -->",
    }),
    false
  );
  assert.equal(
    isGeneratedMetricsOnlyChange({
      ...valid,
      baseReadme: baseReadme.replace("<!-- work-metrics:end -->", ""),
    }),
    false
  );
});

test("metrics title and trusted repository are wired into all validation entry points", async () => {
  const manager = await readFile("scripts/manage-work-metrics.ts", "utf8");
  const validator = await readFile("scripts/validate-change-record.ts", "utf8");
  const selfCI = await readFile(".github/workflows/validate-ci.yml", "utf8");
  const centralPR = await readFile(".github/workflows/handle-pr-dispatch.yml", "utf8");
  const advisoryReview = await readFile(".github/workflows/handle-pr-review.yml", "utf8");
  assert.ok(manager.includes("title=chore(metrics): update work metrics"));
  assert.ok(validator.includes("isGeneratedMetricsOnlyChange("));
  assert.ok(selfCI.includes("AW_VALIDATED_REPOSITORY: ${{ github.repository }}"));
  assert.ok(
    centralPR.includes("AW_VALIDATED_REPOSITORY: ${{ steps.payload.outputs.repository }}")
  );
  assert.ok(
    advisoryReview.includes("AW_VALIDATED_REPOSITORY: ${{ needs.prepare.outputs.repository }}")
  );
});
