import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applyTriage } from "../scripts/apply-ai-triage.ts";
import { parseAiAgentConfig } from "../scripts/ai-agent-config.ts";
import { buildReview } from "../scripts/publish-pr-review.ts";
import { changeAreaForPath } from "../scripts/detect-pr-context.ts";
import { retryLines } from "../scripts/report-ocr-retry.ts";
import { rulesetPayloads, settingsPayload } from "../scripts/apply-repo-settings.ts";
import { shouldResume } from "../scripts/should-resume-ocr.ts";
import { validateDispatch } from "../scripts/validate-dispatch-payload.ts";
import { validateConfigText } from "../scripts/validate-config-naming.ts";
import { assertEnglishText, engineeringLineViolation } from "../scripts/validate-engineering-language.ts";
import { validateEvidence } from "../scripts/validate-ci-evidence.ts";
import { validatePayload } from "../scripts/validate-pr-payload.ts";
import { repositoriesForCapability, validateRepositoryCapability } from "../scripts/repository-policy.ts";
import { validateRelease, validateReleaseProvenance } from "../scripts/validate-release-request.ts";
import { validateReview } from "../scripts/validate-review-result.ts";
import { variableEntries } from "../scripts/export-repository-variables.ts";
import { hasLifecycleFilenameViolation } from "../scripts/validate-naming-rules.ts";
import {
  assertTrustedMainWrite,
  hasTrustedMainWriteGuard,
  parseMainWriteRequest,
  validateMainWriteProvenance,
} from "../scripts/main-write-guard.ts";
import type { GithubReader } from "../scripts/github-api.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("dispatch contracts reject unknown or malformed input", () => {
  validateDispatch({ schema_version: "1", request_id: "req-001", project: "ActionWorker", bootstrap_ref: sha, repository: "fongap-labs/internal-vault" });
  assert.throws(() => validateDispatch({ schema_version: "2", request_id: "req", project: "ActionWorker", bootstrap_ref: sha, repository: "fongap-labs/internal-vault" }));
  assert.throws(() => validateDispatch({ schema_version: "1", request_id: "req", project: "bad/name", bootstrap_ref: sha, repository: "fongap-labs/internal-vault" }));
  assert.throws(() => validateDispatch({ schema_version: "1", request_id: "req", project: "ActionWorker", bootstrap_ref: "main", repository: "fongap-labs/internal-vault" }));
  assert.throws(() => validateDispatch({ schema_version: "1", request_id: "req", project: "ActionWorker", bootstrap_ref: sha, repository: "fongap-labs/internal-vault", command: "unsafe" }));
});

test("PR task and repository policy remain fail closed", () => {
  validatePayload({ schema_version: "1", request_id: "pr:1", repository: "fongap/example", pr_number: 1 });
  assert.throws(() => validatePayload({ schema_version: "1", request_id: "pr:1", repository: "fongap/example", pr_number: 0 }));
  const policy = {
    "fongap/example": ["pr", "task"],
    "other/repository": ["pr"],
  };
  validateRepositoryCapability("fongap/example", policy, "pr");
  validateRepositoryCapability("fongap/example", policy, "task");
  assert.throws(() => validateRepositoryCapability("fongap/blocked", policy, "pr"));
  assert.throws(() => validateRepositoryCapability("other/repository", policy, "task"));
  assert.throws(() => validateRepositoryCapability("fongap/example", { "fongap/example": ["pr", "pr"] }, "pr"));
  assert.deepEqual(repositoriesForCapability(policy, "task"), ["fongap/example"]);
});

test("AI triage can only skip safe low-risk code changes", async () => {
  const triagePolicy = JSON.parse(await readFile("policies/triage.json", "utf8")) as unknown;
  const reviewPolicy = JSON.parse(await readFile("policies/review.json", "utf8")) as unknown;
  const aiAgents = parseAiAgentConfig(JSON.stringify({
    schema_version: 1,
    agents: {
      triage: { enabled: true, model: "Code-Air" },
      review: {
        enabled: true,
        model: "Code-Pro",
        routes: {
          security: { model: "Code-Ultra" },
          architecture: { model: "Code-Ultra" },
          deep: { model: "Code-Ultra" },
        },
      },
      writing: { enabled: true, model: "Pro" },
    },
  }));
  const base = {
    context: { change_areas: ["source"], declared_impacts: [] as string[], risk: "medium" },
    review_required: true,
    review_agent: "code",
    review_model: "Code-Pro",
    review_rule: "code.json",
    review_llm_timeout: 300,
    review_task_timeout: 2,
    review_concurrency: 1,
    review_effort: "medium",
  };
  const skipped = applyTriage(base, {
    status: "complete",
    decision: { review_required: false, review_agent: "code", risk: "low", depth: "normal", confidence: 0.97 },
  }, triagePolicy, reviewPolicy, aiAgents);
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
  }, triagePolicy, reviewPolicy, aiAgents);
  assert.equal(protectedResult.review_required, true);
  assert.equal((protectedResult.triage as Record<string, unknown>).action, "keep");

  const upgraded = applyTriage(base, {
    status: "complete",
    decision: { review_required: true, review_agent: "security", risk: "high", depth: "deep", confidence: 0.88 },
  }, triagePolicy, reviewPolicy, aiAgents);
  assert.equal(upgraded.review_agent, "security");
  assert.equal(upgraded.review_model, "Code-Ultra");
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

test("change-area detection keeps changelog metadata out of release routing", () => {
  const workflowPrefixes = [".github/workflows/"];
  assert.equal(changeAreaForPath("CHANGELOG.md", workflowPrefixes, "CHANGELOG.md"), "documentation");
  assert.equal(changeAreaForPath("docs/release.md", workflowPrefixes, "CHANGELOG.md"), "documentation");
  assert.equal(changeAreaForPath(".github/workflows/release.yml", workflowPrefixes, "CHANGELOG.md"), "workflow");
  assert.equal(changeAreaForPath("scripts/publish-release.ts", workflowPrefixes, "CHANGELOG.md"), "script");
  assert.equal(changeAreaForPath("src/request/model-fallback.ts", workflowPrefixes, "CHANGELOG.md"), "source");
});

test("external configuration recognizes registered system prefixes", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/release.yml", "${{ vars.DELTA_RELEASE_TARGET_REPOSITORY }}"),
    [],
  );
  assert.ok(
    validateConfigText(".github/workflows/release.yml", "${{ vars.RELEASE_TARGET_REPOSITORY }}").length > 0,
  );
});

test("Server Edge external configuration uses its registered owner prefix", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/deployment-readiness.yml", "${{ vars.SERVER_EDGE_TARGET_HOST }}"),
    [],
  );
  assert.ok(
    validateConfigText(".github/workflows/deployment-readiness.yml", "${{ vars.EDGE_TARGET_HOST }}").length > 0,
  );
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

test("lifecycle filename rule distinguishes control labels from domain concepts", () => {
  assert.equal(hasLifecycleFilenameViolation("scripts/release-final.ts"), true);
  assert.equal(hasLifecycleFilenameViolation(".github/workflows/deploy-temp.yml"), true);
  assert.equal(hasLifecycleFilenameViolation("projects/SecurePigeon/crates/pigeon-store/src/temp_access.rs"), false);
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

test("repository ruleset policy is exact and rejects duplicate managed names", () => {
  const rulesets = rulesetPayloads({
    schema_version: 1,
    rulesets: [{
      name: "Protect Main Branch",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      rules: [{ type: "deletion" }],
    }],
  });
  assert.equal(rulesets.length, 1);
  assert.equal(rulesets[0]?.name, "Protect Main Branch");
  assert.throws(() => rulesetPayloads({
    schema_version: 1,
    rulesets: [
      rulesets[0],
      rulesets[0],
    ],
  }));
});

test("release contracts bind source, artifact provenance, target, assets, and license", () => {
  const request = {
    schema_version: "2",
    request_id: "release-1",
    source_repository: "fongap/source",
    source_sha: sha,
    artifact_repository: "fongap/control",
    artifact_run_id: 123,
    artifact_name: "release-package",
  };
  const provenance = {
    schema_version: "1",
    source_repository: "fongap/source",
    source_sha: sha,
    artifact_repository: "fongap/control",
    artifact_run_id: 123,
  };
  const manifest = {
    schema_version: "1", target_repository: "fongap/target", release_key: "example-tool", version: "1.2.3",
    license: { expression: "MPL-2.0", file: "LICENSE.txt" },
    assets: [
      { name: "example.tar.gz", sha256: "a".repeat(64) },
      { name: "LICENSE.txt", sha256: "b".repeat(64) },
    ],
  };
  const policy = {
    "fongap/source": ["release-source"],
    "fongap/target": ["release-target"],
  };
  validateRelease(request, manifest, policy);
  validateReleaseProvenance(request, provenance);
  assert.throws(() => validateReleaseProvenance(request, { ...provenance, artifact_run_id: 124 }));
  assert.throws(() => validateRelease(request, { ...manifest, release_key: "Example Tool" }, policy));
  assert.throws(() => validateRelease(request, { ...manifest, assets: manifest.assets.slice(0, 1) }, policy));
  assert.throws(() => validateRelease(request, undefined, { "fongap/other": ["release-source"], "fongap/target": ["release-target"] }));
});

test("PR review summary keeps AI findings advisory", () => {
  const body = buildReview("failure", "https://example.test/run", {
    context: { risk: "high" }, triage: { status: "complete", action: "upgrade" }, review_agent: "security",
    review_model: "Code-Ultra",
  }, { comments: [{ severity: "high", path: "src/a.ts", start_line: 12, category: "security", content: "Finding" }] });
  assert.match(body, /Gate: \*\*FAIL\*\*/);
  assert.match(body, /AI Review role: advisory only/);
  assert.doesNotMatch(body, /Blocking threshold/);
  assert.match(body, /security/);
  assert.match(body, /src\/a\.ts:12/);
});


test("main write contract is exact and rejects caller trust claims", () => {
  const request = {
    schema_version: "1",
    request_id: "main:1",
    repository: "fongap/example",
    before_sha: "1".repeat(40),
    head_sha: "2".repeat(40),
    event: "push",
  };
  assert.deepEqual(parseMainWriteRequest(request), request);
  assert.throws(() => parseMainWriteRequest({ ...request, trusted: true }));
  assert.throws(() => parseMainWriteRequest({ ...request, head_sha: request.before_sha }));
});

test("main write guard accepts central merge authority and preserves local self-check mode", async () => {
  const mainSha = "2".repeat(40);
  const prHeadSha = "3".repeat(40);
  const paths = new Map<string, unknown>([
    ["repos/fongap/example", { default_branch: "main" }],
    [`repos/fongap/example/commits/${mainSha}`, { sha: mainSha }],
    [`repos/fongap/example/commits/${mainSha}/pulls?per_page=100`, [{
      number: 7,
      merged_at: "2026-09-25T00:00:00Z",
      merge_commit_sha: mainSha,
      base: { ref: "main" },
    }]],
    ["repos/fongap/example/pulls/7", {
      number: 7,
      merged_at: "2026-09-25T00:00:00Z",
      merge_commit_sha: mainSha,
      base: { ref: "main" },
      head: { sha: prHeadSha },
    }],
    [`repos/fongap/example/commits/${prHeadSha}/check-runs?filter=latest&per_page=100`, {
      check_runs: [{
        name: "validate-merge",
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      }],
    }],
    [`repos/fongap/example/commits/${prHeadSha}/status`, {
      statuses: [
        { context: "PR Governance", state: "success", target_url: "https://github.com/fongap-labs/action-worker/actions/runs/1" },
        { context: "CI Evidence", state: "success", target_url: "https://github.com/fongap-labs/action-worker/actions/runs/2" },
        { context: "validate-merge", state: "success", target_url: "https://github.com/fongap-labs/action-worker/actions/runs/1" },
      ],
    }],
    [`repos/fongap/example/commits/${mainSha}/status`, {
      statuses: [
        { context: "Main Write Guard", state: "success", target_url: "https://github.com/fongap-labs/action-worker/actions/runs/3" },
      ],
    }],
  ]);
  const reader = {
    get: async (path: string) => {
      if (!paths.has(path)) {
        throw new Error(`unexpected path: ${path}`);
      }
      return paths.get(path);
    },
  } as unknown as GithubReader;

  const provenance = await validateMainWriteProvenance(reader, "fongap/example", mainSha, true);
  assert.equal(provenance.pr_number, 7);
  assert.equal(provenance.pr_head_sha, prHeadSha);
  assert.equal((await validateMainWriteProvenance(reader, "fongap/example", mainSha, false)).pr_number, 7);
  assert.equal((await assertTrustedMainWrite(reader, "fongap/example", mainSha, true)).main_sha, mainSha);
  assert.equal(hasTrustedMainWriteGuard(paths.get(`repos/fongap/example/commits/${mainSha}/status`)), true);
});

test("main write provenance rejects direct pushes and fake status-only trust", async () => {
  const mainSha = "4".repeat(40);
  const paths = new Map<string, unknown>([
    ["repos/fongap/example", { default_branch: "main" }],
    [`repos/fongap/example/commits/${mainSha}`, { sha: mainSha }],
    [`repos/fongap/example/commits/${mainSha}/pulls?per_page=100`, []],
    [`repos/fongap/example/commits/${mainSha}/status`, {
      statuses: [
        { context: "Main Write Guard", state: "success", target_url: "https://github.com/fongap-labs/action-worker/actions/runs/9" },
      ],
    }],
  ]);
  const reader = {
    get: async (path: string) => paths.get(path),
  } as unknown as GithubReader;

  assert.equal(hasTrustedMainWriteGuard(paths.get(`repos/fongap/example/commits/${mainSha}/status`)), true);
  await assert.rejects(() => validateMainWriteProvenance(reader, "fongap/example", mainSha, false));
  await assert.rejects(() => assertTrustedMainWrite(reader, "fongap/example", mainSha, false));
});
