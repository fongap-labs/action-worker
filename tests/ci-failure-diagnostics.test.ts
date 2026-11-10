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
    findings.map((finding) => [finding.kind, finding.severity, finding.recoverability]),
    [
      ["security_gate", "high", "unknown"],
      ["permission", "high", "unknown"],
      ["source_test", "medium", "unknown"],
    ]
  );
  assert.ok(findings.every((finding) => finding.evidence === "step_name"));
});

test("job error text distinguishes temporary faults from permanent blockers", () => {
  const cases = [
    ["temporary network failure: ECONNRESET", "transient_network", "safe_retry"],
    ["API rate limit exceeded (HTTP 429); Retry-After: 30", "api_rate_limit", "safe_retry"],
    ["Cloudflare returned HTTP 503 Service Unavailable", "upstream_service", "safe_retry"],
    ["The hosted runner lost communication with the server", "runner", "safe_retry"],
    ["npm ERR! ERESOLVE unable to resolve dependency tree", "dependency", "do_not_retry"],
    ["AIG_PUBLIC_URL is invalid", "configuration", "do_not_retry"],
    ["Resource not accessible by integration (HTTP 403)", "permission", "do_not_retry"],
    [
      "Missing required ai-gateway-ops configuration: CLOUDFLARE_API_TOKEN_OPS",
      "credential_missing",
      "do_not_retry",
    ],
    ["AssertionError: expected 2 to equal 3", "source_test", "do_not_retry"],
    ["Secret scanning security gate failed", "security_gate", "do_not_retry"],
    ["Task expired because the head SHA was superseded", "stale_task", "do_not_retry"],
    ["Unexpected gateway response", "unknown", "unknown"],
  ] as const;

  for (const [detail, kind, recoverability] of cases) {
    const finding = classifyFailure("Arbitrary step name", "Run", detail);
    assert.equal(finding.kind, kind, detail);
    assert.equal(finding.recoverability, recoverability, detail);
    assert.equal(finding.evidence, "job_log", detail);
  }
});

test("actual error evidence overrides a misleading step name", () => {
  const finding = classifyFailure(
    "Security checks",
    "Validate security gate",
    "npm ERR! ERESOLVE unable to resolve dependency tree"
  );
  assert.equal(finding.kind, "dependency");
  assert.equal(finding.recoverability, "do_not_retry");
});

test("summary uses job logs when available and never prints raw error text", () => {
  const detail = "Missing required ai-gateway-ops configuration: TOKEN_VALUE_SHOULD_NOT_APPEAR";
  const findings = summarizeFailures(
    [
      {
        id: 42,
        name: "Inspect secret",
        conclusion: "failure",
        steps: [{ name: "Inspect credentials", conclusion: "failure" }],
      },
    ],
    new Map([[42, detail]])
  );
  const summary = markdownFailureSummary(findings, "fongap-labs/action-worker", "123");
  assert.match(summary, /credential_missing/);
  assert.match(summary, /do_not_retry/);
  assert.doesNotMatch(summary, /TOKEN_VALUE_SHOULD_NOT_APPEAR/);
});

test("missing logs never authorize a retry and unknown step labels stay unknown", () => {
  assert.equal(classifyFailure("Linux CI", "Install dependencies").kind, "dependency");
  assert.equal(classifyFailure("Linux CI", "Install dependencies").recoverability, "unknown");
  assert.equal(classifyFailure("New job", "Unrecognized phase").kind, "unknown");
  assert.deepEqual(summarizeFailures([{ name: "Skipped", conclusion: "skipped" }]), []);
});

test("CI diagnostics avoid duplicate alerts and escape unsafe markdown delimiters", () => {
  const summary = markdownFailureSummary(
    [classifyFailure("job | secret", "Unsafe\nstep")],
    "fongap-labs/action-worker",
    "123"
  );
  assert.match(summary, /actions\/runs\/123/);
  assert.doesNotMatch(summary, /Unsafe\nstep/);
  assert.match(summary, /cannot override the merge gate/);
  assert.match(summary, /job secret/);
});

test("the existing merge gate remains mandatory and diagnostics run only after a failure", async () => {
  const workflow = await readFile(".github/workflows/validate-ci.yml", "utf8");
  assert.match(workflow, /- name: Aggregate merge gate/);
  assert.match(workflow, /- name: Classify failed steps\n\s+if: failure\(\)/);
  assert.match(workflow, /run: node scripts\/diagnose-ci-failure\.ts/);
  assert.match(workflow, /actions: read/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});

test("failed CI jobs link to exact trusted GitHub jobs without allowing arbitrary URLs", () => {
  const findings = summarizeFailures([
    {
      name: "Static analysis",
      conclusion: "failure",
      html_url: "https://github.com/fongap-labs/action-worker/actions/runs/123/job/456",
      steps: [{ name: "Lint with Biome", conclusion: "failure" }],
    },
    {
      name: "Security checks",
      conclusion: "failure",
      html_url: "https://evil.example.org/inject",
      steps: [{ name: "Validate security gate", conclusion: "failure" }],
    },
  ]);
  const summary = markdownFailureSummary(findings, "fongap-labs/action-worker", "123");
  assert.match(
    summary,
    /\[Static analysis\]\(https:\/\/github\.com\/fongap-labs\/action-worker\/actions\/runs\/123\/job\/456\)/
  );
  assert.doesNotMatch(summary, /evil\.example\.org/);
});
