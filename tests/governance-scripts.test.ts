import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applyTriage } from "../scripts/apply-ai-triage.ts";
import { buildReview } from "../scripts/publish-pr-review.ts";
import { retryLines } from "../scripts/report-ocr-retry.ts";
import { settingsPayload } from "../scripts/apply-repo-settings.ts";
import { shouldResume } from "../scripts/should-resume-ocr.ts";
import { validateDispatch } from "../scripts/validate-dispatch-payload.ts";
import { assertEnglishText, engineeringLineViolation } from "../scripts/validate-engineering-language.ts";
import { validateEvidence } from "../scripts/validate-ci-evidence.ts";
import { validatePayload } from "../scripts/validate-pr-payload.ts";
import { validateRepository } from "../scripts/validate-pr-repository.ts";
import { validateRelease } from "../scripts/validate-release-request.ts";
import { validateReview } from "../scripts/validate-review-result.ts";
import { variableEntries } from "../scripts/export-repository-variables.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("dispatch contracts reject unknown or malformed input", () => {
  validateDispatch({ schema_version: "1", request_id: "req-001", project: "ActionWorker", bootstrap_ref: sha, repository: "fongap-labs/internal-vault" });
  assert.throws(() => validateDispatch({ schema_version: "2", request_id: "req", project: "ActionWorker", bootstrap_ref: sha, repository: "fongap-labs/internal-vault" }));
  assert.throws(() => validateDispatch({ schema_version: "1", request_id: "req", project: "bad/name", bootstrap_ref: sha, repository: "fongap-labs/internal-vault" }));
  assert.throws(() => validateDispatch({ schema_version: "1", request_id: "req", project: "ActionWorker", bootstrap_ref: "main", repository: "fongap-labs/internal-vault" }));
  assert.throws(() => validateDispatch({ schema_version: "1", request_id: "req", project: "ActionWorker", bootstrap_ref: sha, repository: "fongap-labs/internal-vault", command: "unsafe" }));
});

test("PR task and repository allowlist remain fail closed", () => {
  validatePayload({ schema_version: "1", request_id: "pr:1", repository: "fongap/example", pr_number: 1 });
  assert.throws(() => validatePayload({ schema_version: "1", request_id: "pr:1", repository: "fongap/example", pr_number: 0 }));
  validateRepository("fongap/example", ["fongap/example", "other/repository"]);
  assert.throws(() => validateRepository("fongap/blocked", ["fongap/example"]));
  assert.throws(() => validateRepository("fongap/example", ["fongap/example", "fongap/example"]));
});

test("AI triage can only skip safe low-risk code changes", async () => {
  const triagePolicy = JSON.parse(await readFile("policies/triage.json", "utf8")) as unknown;
  const reviewPolicy = JSON.parse(await readFile("policies/review.json", "utf8")) as unknown;
  const base = {
    context: { change_areas: ["source"], declared_impacts: [] as string[], risk: "medium" },
    review_required: true,
    review_agent: "code",
    review_model: "Code-Pro",
    review_rule: "code.json",
    review_llm_timeout: 300,
    review_task_timeout: 2,
    review_concurrency: 1,
    block_severity: "critical",
    review_effort: "medium",
  };
  const skipped = applyTriage(base, {
    status: "complete",
    decision: { review_required: false, review_agent: "code", risk: "low", depth: "normal", confidence: 0.97 },
  }, triagePolicy, reviewPolicy);
  assert.equal(skipped.review_required, false);
  assert.deepEqual(skipped.triage, {
    status: "complete",
    action: "skip",
    result: {
      status: "complete",
      decision: { review_required: false, review_agent: "code", risk: "low", depth: "normal", confidence: 0.97 },
    },
  });

  const protectedPlan = structuredClone(base);
  protectedPlan.context.declared_impacts = ["breaking"];
  const protectedResult = applyTriage(protectedPlan, {
    status: "complete",
    decision: { review_required: false, review_agent: "code", risk: "low", depth: "normal", confidence: 0.99 },
  }, triagePolicy, reviewPolicy);
  assert.equal(protectedResult.review_required, true);
  assert.equal((protectedResult.triage as Record<string, unknown>).action, "keep");

  const upgraded = applyTriage(base, {
    status: "complete",
    decision: { review_required: true, review_agent: "security", risk: "high", depth: "deep", confidence: 0.88 },
  }, triagePolicy, reviewPolicy);
  assert.equal(upgraded.review_agent, "security");
  assert.equal(upgraded.review_model, "Code-Ultra");
  assert.equal(upgraded.block_severity, "high");
});

test("CI and review results require complete successful evidence", () => {
  validateEvidence({
    repository: "fongap/example",
    head_sha: sha,
    workflow: "ci.yml",
    gate_job: "ci-evidence",
    run_id: 12,
    gate_conclusion: "success",
    jobs: [],
  });
  assert.throws(() => validateEvidence({
    repository: "fongap/example",
    head_sha: sha,
    workflow: "ci.yml",
    gate_job: "ci-evidence",
    run_id: 12,
    gate_conclusion: "failure",
    jobs: [],
  }));
  validateReview({ status: "complete", comments: [] });
  validateReview({ status: "success", comments: [] });
  validateReview({ status: "complete", manifest: { terminal_state: "complete" }, comments: [] });
  assert.throws(() => validateReview({ status: "complete", manifest: { terminal_state: "partial" }, comments: [] }));
  assert.throws(() => validateReview({ status: "failed", comments: [] }));
});

test("OCR resume only accepts transient terminal failures", () => {
  const result = (errorClass: string, statusCode: number, status = "failed") => ({
    status,
    session_id: "session-1",
    retry_report: {
      schema_version: "ocr.llm-retry-report/v1",
      requests: [{ outcome: "failed", attempts: [{ outcome: "error", error_class: errorClass, status_code: statusCode }] }],
    },
  });
  assert.equal(shouldResume(result("timeout", 504)), true);
  assert.equal(shouldResume(result("provider", 503)), true);
  assert.equal(shouldResume(result("authentication", 401)), false);
  assert.equal(shouldResume(result("timeout", 504, "complete")), false);
});

test("OCR retry diagnostics exclude provider request identifiers", () => {
  const lines = retryLines({
    retry_report: {
      schema_version: "ocr.llm-retry-report/v1",
      total_requests: 2,
      retried_requests: 1,
      total_retries: 1,
      requests: [{
        model: "Code-Ultra",
        file_path: "src/example.ts",
        task_type: "main_task",
        request_no: 1,
        attempts: [{ outcome: "error", status_code: 429, error_class: "rate_limited", failure_phase: "http" }],
      }],
    },
  });
  assert.match(lines.join("\n"), /status=429 class=rate_limited phase=http/);
  assert.doesNotMatch(lines.join("\n"), /request_id=/);
});

test("engineering language rejects Chinese machine text but allows documentation and UI strings", () => {
  assert.doesNotThrow(() => assertEnglishText("PR title summary", "centralize merge policy"));
  assert.throws(() => assertEnglishText("PR title summary", "统一合并门禁"));
  assert.equal(engineeringLineViolation("CHANGELOG.md", "- fix: 修复路由。"), "CHANGELOG entries must use English.");
  assert.equal(engineeringLineViolation(".github/workflows/ci.yml", "name: 校验"), "Workflow engineering text must use English.");
  assert.equal(engineeringLineViolation("src/router.ts", "// 修复路由"), "Engineering identifiers and comments must use English.");
  assert.equal(engineeringLineViolation("src/router.ts", 'console.error("上游失败")'), "Logs, errors, and test descriptions must use English.");
  assert.equal(engineeringLineViolation("src/router.ts", 'const label = "中文界面";'), null);
  assert.equal(engineeringLineViolation("docs/README.md", "中文说明"), null);
  assert.equal(engineeringLineViolation("src/i18n/zh-CN.json", '"title": "中文界面"'), null);
});

test("repository variables are sorted and validated", () => {
  assert.deepEqual(variableEntries({ MULTI: "line1\nline2", EMPTY: "", ALPHA: "one" }), [
    ["ALPHA", "one"], ["EMPTY", ""], ["MULTI", "line1\nline2"],
  ]);
  assert.throws(() => variableEntries({ "BAD-NAME": "value" }));
});

test("repository settings omit schema metadata", () => {
  assert.deepEqual(settingsPayload({ schema_version: 1, has_issues: true }), { has_issues: true });
});

test("release contracts validate source, target, assets, and license", () => {
  const request = {
    schema_version: "1", request_id: "release-1", repository: "fongap/source", source_sha: sha,
    source_run_id: 123, artifact_name: "release-package",
  };
  const manifest = {
    schema_version: "1", target_repository: "fongap/target", release_key: "example-tool", version: "1.2.3",
    license: { expression: "MPL-2.0", file: "LICENSE.txt" },
    assets: [
      { name: "example.tar.gz", sha256: "a".repeat(64) },
      { name: "LICENSE.txt", sha256: "b".repeat(64) },
    ],
  };
  validateRelease(request, manifest, ["fongap/source"], ["fongap/target"]);
  assert.throws(() => validateRelease(request, { ...manifest, release_key: "Example Tool" }, ["fongap/source"], ["fongap/target"]));
  assert.throws(() => validateRelease(request, { ...manifest, assets: manifest.assets.slice(0, 1) }, ["fongap/source"], ["fongap/target"]));
  assert.throws(() => validateRelease(request, undefined, ["fongap/other"], ["fongap/target"]));
});

test("PR review summary includes gate, routing, and findings", () => {
  const body = buildReview("failure", "https://example.test/run", {
    context: { risk: "high" }, triage: { status: "complete", action: "upgrade" }, review_agent: "security",
    review_model: "Code-Ultra", block_severity: "high",
  }, { comments: [{ severity: "high", path: "src/a.ts", start_line: 12, category: "security", content: "Finding" }] });
  assert.match(body, /Gate: \*\*FAIL\*\*/);
  assert.match(body, /security/);
  assert.match(body, /src\/a\.ts:12/);
});
