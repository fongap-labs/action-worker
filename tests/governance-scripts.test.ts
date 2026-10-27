import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAiAgentConfig } from "../scripts/ai-agent-config.ts";
import { applyTriage } from "../scripts/apply-ai-triage.ts";
import { rulesetPayloads, settingsPayload } from "../scripts/apply-repository-settings.ts";
import { changeAreaForPath } from "../scripts/detect-pr-context.ts";
import { variableEntries } from "../scripts/export-repository-variables.ts";
import type { GithubReader } from "../scripts/github-api.ts";
import {
  assertTrustedMainWrite,
  hasVerifiedMainWriteGuard,
  parseMainWriteRequest,
  validateMainWriteProvenance,
} from "../scripts/main-write-guard.ts";
import { buildReview } from "../scripts/publish-pr-review.ts";
import { retryLines } from "../scripts/report-ocr-retry.ts";
import {
  hasRepositoryCapability,
  repositoriesForCapability,
  validateRepositoryCapability,
} from "../scripts/repository-policy.ts";
import { shouldResume } from "../scripts/should-resume-ocr.ts";
import { validateEvidence } from "../scripts/validate-ci-evidence.ts";
import { validateConfigText } from "../scripts/validate-config-naming.ts";
import { validateDispatch } from "../scripts/validate-dispatch-payload.ts";
import {
  assertEnglishText,
  diffHeaderPath,
  engineeringLineViolation,
  scanHtmlComments,
  validateEngineeringDiff,
} from "../scripts/validate-engineering-language.ts";
import { hasLifecycleFilenameViolation } from "../scripts/validate-naming-rules.ts";
import { validatePayload } from "../scripts/validate-pr-payload.ts";
import { validateRelease, validateReleaseProvenance } from "../scripts/validate-release-request.ts";
import { validateReview } from "../scripts/validate-review-result.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("dispatch contracts reject unknown or malformed input", () => {
  validateDispatch({
    schema_version: "1",
    request_id: "req-001",
    project: "ActionWorker",
    bootstrap_ref: sha,
    repository: "fongap-labs/internal-vault",
  });
  assert.throws(() =>
    validateDispatch({
      schema_version: "2",
      request_id: "req",
      project: "ActionWorker",
      bootstrap_ref: sha,
      repository: "fongap-labs/internal-vault",
    })
  );
  assert.throws(() =>
    validateDispatch({
      schema_version: "1",
      request_id: "req",
      project: "bad/name",
      bootstrap_ref: sha,
      repository: "fongap-labs/internal-vault",
    })
  );
  assert.throws(() =>
    validateDispatch({
      schema_version: "1",
      request_id: "req",
      project: "ActionWorker",
      bootstrap_ref: "main",
      repository: "fongap-labs/internal-vault",
    })
  );
  assert.throws(() =>
    validateDispatch({
      schema_version: "1",
      request_id: "req",
      project: "ActionWorker",
      bootstrap_ref: sha,
      repository: "fongap-labs/internal-vault",
      command: "unsafe",
    })
  );
});

test("PR task and repository policy remain fail closed", () => {
  validatePayload({
    schema_version: "1",
    request_id: "pr:1",
    repository: "fongap/example",
    pr_number: 1,
  });
  assert.throws(() =>
    validatePayload({
      schema_version: "1",
      request_id: "pr:1",
      repository: "fongap/example",
      pr_number: 0,
    })
  );
  const policy = {
    "fongap/example": ["pr", "task"],
    "other/repository": ["pr"],
  };
  validateRepositoryCapability("fongap/example", policy, "pr");
  validateRepositoryCapability("fongap/example", policy, "task");
  assert.throws(() => validateRepositoryCapability("fongap/blocked", policy, "pr"));
  assert.throws(() => validateRepositoryCapability("other/repository", policy, "task"));
  assert.throws(() =>
    validateRepositoryCapability("fongap/example", { "fongap/example": ["pr", "pr"] }, "pr")
  );
  assert.deepEqual(repositoriesForCapability(policy, "task"), ["fongap/example"]);
  // A bare name is corrected to the managed repository; an unmanaged one lists the managed ones.
  assert.throws(
    () => validateRepositoryCapability("example", policy, "task"),
    /Enter it as owner\/name, for example fongap\/example\./
  );
  assert.throws(
    () => validateRepositoryCapability("unknown", policy, "task"),
    (error: Error) => error.message.endsWith("Enter it as owner/name.")
  );
  assert.throws(
    () => validateRepositoryCapability("other/repository", policy, "task"),
    /Repositories with this capability: fongap\/example\./
  );
  assert.equal(hasRepositoryCapability("fongap/example", policy, "task"), true);
  assert.equal(hasRepositoryCapability("fongap/example", policy, "deploy"), false);
  assert.equal(hasRepositoryCapability("fongap/unknown", policy, "pr"), false);
});

test("AI triage can only skip safe low-risk code changes", async () => {
  const triagePolicy = JSON.parse(await readFile("policies/triage.json", "utf8")) as unknown;
  const reviewPolicy = JSON.parse(await readFile("policies/review.json", "utf8")) as unknown;
  const aiAgents = parseAiAgentConfig(
    JSON.stringify({
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
    })
  );
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
  const skipped = applyTriage(
    base,
    {
      status: "complete",
      decision: {
        review_required: false,
        review_agent: "code",
        risk: "low",
        depth: "normal",
        confidence: 0.97,
      },
    },
    triagePolicy,
    reviewPolicy,
    aiAgents
  );
  assert.equal(skipped.review_required, false);
  assert.deepEqual(skipped.triage, {
    status: "complete",
    action: "skip",
    result: {
      status: "complete",
      decision: {
        review_required: false,
        review_agent: "code",
        risk: "low",
        depth: "normal",
        confidence: 0.97,
      },
    },
  });

  const protectedPlan = structuredClone(base);
  protectedPlan.context.declared_impacts = ["breaking"];
  const protectedResult = applyTriage(
    protectedPlan,
    {
      status: "complete",
      decision: {
        review_required: false,
        review_agent: "code",
        risk: "low",
        depth: "normal",
        confidence: 0.99,
      },
    },
    triagePolicy,
    reviewPolicy,
    aiAgents
  );
  assert.equal(protectedResult.review_required, true);
  assert.equal((protectedResult.triage as Record<string, unknown>).action, "keep");

  const upgraded = applyTriage(
    base,
    {
      status: "complete",
      decision: {
        review_required: true,
        review_agent: "security",
        risk: "high",
        depth: "deep",
        confidence: 0.88,
      },
    },
    triagePolicy,
    reviewPolicy,
    aiAgents
  );
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
  assert.throws(() =>
    validateEvidence({
      repository: "fongap/example",
      head_sha: sha,
      workflow: "ci.yml",
      gate_job: "ci-evidence",
      run_id: 12,
      gate_conclusion: "failure",
      jobs: [],
    })
  );
  validateReview({ status: "complete", comments: [] });
  validateReview({ status: "success", comments: [] });
  validateReview({ status: "complete", manifest: { terminal_state: "complete" }, comments: [] });
  assert.throws(() =>
    validateReview({ status: "complete", manifest: { terminal_state: "partial" }, comments: [] })
  );
  assert.throws(() => validateReview({ status: "failed", comments: [] }));
});

test("OCR resume only accepts transient terminal failures", () => {
  const result = (errorClass: string, statusCode: number, status = "failed") => ({
    status,
    session_id: "session-1",
    retry_report: {
      schema_version: "ocr.llm-retry-report/v1",
      requests: [
        {
          outcome: "failed",
          attempts: [{ outcome: "error", error_class: errorClass, status_code: statusCode }],
        },
      ],
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
      requests: [
        {
          model: "Code-Ultra",
          file_path: "src/example.ts",
          task_type: "main_task",
          request_no: 1,
          attempts: [
            {
              outcome: "error",
              status_code: 429,
              error_class: "rate_limited",
              failure_phase: "http",
            },
          ],
        },
      ],
    },
  });
  assert.match(lines.join("\n"), /status=429 class=rate_limited phase=http/);
  assert.doesNotMatch(lines.join("\n"), /request_id=/);
});

test("change-area detection keeps changelog metadata out of release routing", () => {
  const workflowPrefixes = [".github/workflows/"];
  assert.equal(
    changeAreaForPath("CHANGELOG.md", workflowPrefixes, "CHANGELOG.md"),
    "documentation"
  );
  assert.equal(
    changeAreaForPath("docs/release.md", workflowPrefixes, "CHANGELOG.md"),
    "documentation"
  );
  assert.equal(
    changeAreaForPath(".github/workflows/release.yml", workflowPrefixes, "CHANGELOG.md"),
    "workflow"
  );
  assert.equal(
    changeAreaForPath("scripts/publish-release.ts", workflowPrefixes, "CHANGELOG.md"),
    "script"
  );
  assert.equal(
    changeAreaForPath("src/request/model-fallback.ts", workflowPrefixes, "CHANGELOG.md"),
    "source"
  );
});

test("external configuration recognizes registered system prefixes", () => {
  assert.deepEqual(
    validateConfigText(
      ".github/workflows/release.yml",
      "${{ vars.DELTA_RELEASE_TARGET_REPOSITORY }}"
    ),
    []
  );
  assert.ok(
    validateConfigText(".github/workflows/release.yml", "${{ vars.RELEASE_TARGET_REPOSITORY }}")
      .length > 0
  );
});

test("Server Edge external configuration uses its registered owner prefix", () => {
  assert.deepEqual(
    validateConfigText(
      ".github/workflows/deployment-readiness.yml",
      "${{ vars.SERVER_EDGE_TARGET_HOST }}"
    ),
    []
  );
  assert.ok(
    validateConfigText(".github/workflows/deployment-readiness.yml", "${{ vars.EDGE_TARGET_HOST }}")
      .length > 0
  );
});

test("engineering language rejects Chinese machine text but allows documentation and UI strings", () => {
  assert.doesNotThrow(() => assertEnglishText("PR title summary", "centralize merge policy"));
  assert.throws(() => assertEnglishText("PR title summary", "统一合并门禁"));
  assert.equal(engineeringLineViolation("CHANGELOG.md", "- 修复: 修复路由。"), null);
  assert.equal(engineeringLineViolation(".github/workflows/ci.yml", "name: 校验"), null);
  // Workflow input descriptions are user-facing copy and stay exempt.
  assert.equal(
    engineeringLineViolation(".github/workflows/ci.yml", "description: 源仓库（owner/name 形式）"),
    null
  );
  assert.equal(
    engineeringLineViolation(".github/workflows/ci.yml", "run: echo 校验"),
    "Workflow engineering text must use English."
  );
  assert.equal(
    engineeringLineViolation("src/router.ts", "// 修复路由"),
    "Engineering identifiers and comments must use English."
  );
  assert.equal(
    engineeringLineViolation("src/router.ts", 'console.error("上游失败")'),
    "Logs, errors, and test descriptions must use English."
  );
  assert.equal(engineeringLineViolation("src/router.ts", 'const label = "中文界面";'), null);
  assert.equal(engineeringLineViolation("docs/README.md", "中文说明"), null);
  assert.equal(engineeringLineViolation("src/i18n/zh-CN.json", '"title": "中文界面"'), null);
  assert.equal(
    engineeringLineViolation("output/adfilter/adfilter.txt", "||ads.中文.example.com^"),
    null
  );
  assert.equal(engineeringLineViolation("data/export.csv", "中文,1"), null);
  // Vendored minified bundles are exempt; the same text in authored code is not.
  assert.equal(engineeringLineViolation("assets/js/lib.min.js", 'console.error("上游失败")'), null);
  assert.equal(engineeringLineViolation("assets/css/lib.min.css", "/* 中文 */"), null);
  assert.equal(
    engineeringLineViolation("assets/js/app.js", 'console.error("上游失败")'),
    "Logs, errors, and test descriptions must use English."
  );
});

test("engineering language exempts HTML template copy but rejects template comments", () => {
  // Text between tags is user-facing copy; quoted attribute values are already stripped.
  assert.equal(engineeringLineViolation("layouts/index.html", "<h2>订阅本站</h2>", ""), null);
  assert.equal(
    engineeringLineViolation("layouts/page.html", '<p class="note">不含广告与追踪。</p>', ""),
    null
  );
  // Template comments stay English.
  assert.equal(
    engineeringLineViolation(
      "layouts/_partials/links.html",
      "{{/* 合并所有链接数据 */}}",
      " 合并所有链接数据 "
    ),
    "Engineering identifiers and comments must use English."
  );
  assert.equal(
    engineeringLineViolation(
      "layouts/_partials/foot.html",
      "<!-- 页脚：版权与导航 -->",
      " 页脚：版权与导航 "
    ),
    "Engineering identifiers and comments must use English."
  );
  // Embedded logs stay English.
  assert.equal(
    engineeringLineViolation(
      "layouts/embed.html",
      '<script>console.error("上游失败")</script>',
      ""
    ),
    "Logs, errors, and test descriptions must use English."
  );
});

test("HTML template comments are tracked across lines while template code is exempt", () => {
  let scan = scanHtmlComments({ inComment: false }, '<section class="card">');
  assert.deepEqual(scan.state, { inComment: false });
  assert.equal(scan.commentText, "");

  scan = scanHtmlComments(scan.state, "{{/*");
  assert.deepEqual(scan.state, { inComment: true, kind: "hugo" });

  scan = scanHtmlComments(scan.state, "  合并所有链接数据：F 与 E 两组");
  assert.equal(
    engineeringLineViolation(
      "layouts/links.html",
      "  合并所有链接数据：F 与 E 两组",
      scan.commentText
    ),
    "Engineering identifiers and comments must use English."
  );

  scan = scanHtmlComments(scan.state, "  {{< site-now >}}");
  assert.equal(
    engineeringLineViolation("layouts/links.html", "  {{< site-now >}}", scan.commentText),
    null
  );

  scan = scanHtmlComments(scan.state, "*/ -}}");
  assert.deepEqual(scan.state, { inComment: false });

  scan = scanHtmlComments(scan.state, "<!--");
  assert.deepEqual(scan.state, { inComment: true, kind: "html" });

  scan = scanHtmlComments(scan.state, "  页脚说明");
  assert.equal(
    engineeringLineViolation("layouts/foot.html", "  页脚说明", scan.commentText),
    "Engineering identifiers and comments must use English."
  );

  scan = scanHtmlComments(scan.state, "-->");
  assert.deepEqual(scan.state, { inComment: false });
});

test("engineering language reads quoted diff paths instead of reusing the previous file", async () => {
  assert.equal(diffHeaderPath("+++ b/src/router.ts"), "src/router.ts");
  assert.equal(diffHeaderPath("+++ b/docs/two words.md\t"), "docs/two words.md");
  assert.equal(
    diffHeaderPath('+++ "b/content/pages/\\350\\201\\224\\347\\263\\273.md"'),
    "content/pages/联系.md"
  );
  assert.equal(diffHeaderPath('+++ "b/a\\"b\\\\c.txt"'), 'a"b\\c.txt');
  assert.equal(diffHeaderPath("+++ /dev/null"), null);
  assert.equal(diffHeaderPath("--- a/src/router.ts"), null);

  // CHANGELOG.md sorts before the Chinese-named page; its path must not be reused for that page.
  const root = await mkdtemp(join(tmpdir(), "engineering-language-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "core.quotePath=true", ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    await mkdir(join(root, "content"), { recursive: true });
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n");
    await writeFile(join(root, "content", "联系.md"), "旧内容\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n- fix: refine pages.\n");
    await writeFile(join(root, "content", "联系.md"), "新内容\n");
    git("commit", "-q", "-am", "change");
    const head = git("rev-parse", "HEAD").trim();
    const result = await validateEngineeringDiff(base, head, root);
    assert.deepEqual(result, { files: 2, additions: 3, failures: 0 });

    // CHANGELOG entries are Chinese (CHANGELOG_CONVENTIONS §5), so a Chinese entry passes the
    // language check; the entry format itself is checked by validate-change-record.
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n- 修复: 修复页面。\n");
    git("commit", "-q", "-am", "chinese changelog");
    const chinese = await validateEngineeringDiff(base, git("rev-parse", "HEAD").trim(), root);
    assert.equal(chinese.failures, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engineering language flags template comments and exempts template copy in a diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-language-html-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    const layouts = join(root, "layouts");
    await mkdir(layouts, { recursive: true });
    await writeFile(join(layouts, "index.html"), "<main></main>\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    await writeFile(
      join(layouts, "index.html"),
      [
        "<main>",
        "  {{/*",
        "  中文注释：跨行模板块",
        "  */ -}}",
        "  <h2>订阅本站</h2>",
        "  <p>新文章更新第一时间送达。</p>",
        "</main>",
        "",
      ].join("\n")
    );
    git("commit", "-q", "-am", "change");
    const result = await validateEngineeringDiff(base, git("rev-parse", "HEAD").trim(), root);
    // Only the comment body line fails; the copy between tags is exempt.
    assert.equal(result.failures, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle filename rule distinguishes control labels from domain concepts", () => {
  assert.equal(hasLifecycleFilenameViolation("scripts/release-final.ts"), true);
  assert.equal(hasLifecycleFilenameViolation(".github/workflows/deploy-temp.yml"), true);
  assert.equal(
    hasLifecycleFilenameViolation("projects/SecurePigeon/crates/pigeon-store/src/temp_access.rs"),
    false
  );
});

test("repository variables are sorted and validated", () => {
  assert.deepEqual(variableEntries({ MULTI: "line1\nline2", EMPTY: "", ALPHA: "one" }), [
    ["ALPHA", "one"],
    ["EMPTY", ""],
    ["MULTI", "line1\nline2"],
  ]);
  assert.throws(() => variableEntries({ "BAD-NAME": "value" }));
});

test("repository settings omit schema metadata", () => {
  assert.deepEqual(settingsPayload({ schema_version: 1, has_issues: true }), { has_issues: true });
});

test("repository ruleset policy is exact and rejects duplicate managed names", () => {
  const rulesets = rulesetPayloads({
    schema_version: 1,
    rulesets: [
      {
        name: "Protect Main Branch",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: [{ type: "deletion" }],
      },
    ],
  });
  assert.equal(rulesets.length, 1);
  assert.equal(rulesets[0]?.name, "Protect Main Branch");
  assert.throws(() =>
    rulesetPayloads({
      schema_version: 1,
      rulesets: [rulesets[0], rulesets[0]],
    })
  );
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
    schema_version: "1",
    target_repository: "fongap/target",
    release_key: "example-tool",
    version: "1.2.3",
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
  // A release may carry the entries it owns; the list is bounded and holds single lines only.
  validateRelease(request, { ...manifest, changelog_entries: ["新增: 同步示例。"] }, policy);
  assert.throws(() => validateRelease(request, { ...manifest, changelog_entries: [] }, policy));
  assert.throws(() =>
    validateRelease(request, { ...manifest, changelog_entries: ["新增: 同步\n示例。"] }, policy)
  );
  // A mirrored CRAN package may carry a four-part numeric version (AlgDesign 1.2.1.2); a fifth
  // part, or a non-numeric part, is not a version.
  validateRelease(request, { ...manifest, version: "1.2.1.2" }, policy);
  validateRelease(request, { ...manifest, version: "1.2.1.2-beta.1" }, policy);
  assert.throws(() => validateRelease(request, { ...manifest, version: "1.2.1.2.3" }, policy));
  assert.throws(() => validateRelease(request, { ...manifest, version: "1.2.1.x" }, policy));
  assert.throws(() => validateRelease(request, { ...manifest, version: "1.2" }, policy));
  validateReleaseProvenance(request, provenance);
  assert.throws(() => validateReleaseProvenance(request, { ...provenance, artifact_run_id: 124 }));
  assert.throws(() =>
    validateRelease(request, { ...manifest, release_key: "Example Tool" }, policy)
  );
  assert.throws(() =>
    validateRelease(request, { ...manifest, assets: manifest.assets.slice(0, 1) }, policy)
  );
  assert.throws(() =>
    validateRelease(request, undefined, {
      "fongap/other": ["release-source"],
      "fongap/target": ["release-target"],
    })
  );
});

test("PR review summary keeps AI findings advisory", () => {
  const body = buildReview(
    "failure",
    "https://example.test/run",
    {
      context: { risk: "high" },
      triage: { status: "complete", action: "upgrade" },
      review_agent: "security",
      review_model: "Code-Ultra",
    },
    {
      comments: [
        {
          severity: "high",
          path: "src/a.ts",
          start_line: 12,
          category: "security",
          content: "Finding",
        },
      ],
    }
  );
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
    [
      `repos/fongap/example/commits/${mainSha}/pulls?per_page=100`,
      [
        {
          number: 7,
          merged_at: "2026-09-25T00:00:00Z",
          merge_commit_sha: mainSha,
          base: { ref: "main" },
        },
      ],
    ],
    [
      "repos/fongap/example/pulls/7",
      {
        number: 7,
        merged_at: "2026-09-25T00:00:00Z",
        merge_commit_sha: mainSha,
        base: { ref: "main" },
        head: { sha: prHeadSha },
      },
    ],
    [
      `repos/fongap/example/commits/${prHeadSha}/check-runs?filter=latest&per_page=100`,
      {
        check_runs: [
          {
            name: "validate-merge",
            status: "completed",
            conclusion: "success",
            app: { slug: "github-actions" },
          },
        ],
      },
    ],
    [
      `repos/fongap/example/commits/${prHeadSha}/status`,
      {
        statuses: [
          {
            context: "PR Governance",
            state: "success",
            target_url: "https://github.com/fongap-labs/action-worker/actions/runs/1",
            created_at: "2026-09-25T00:00:20Z",
          },
          {
            context: "CI Evidence",
            state: "success",
            target_url: "https://github.com/fongap-labs/action-worker/actions/runs/2",
            created_at: "2026-09-25T00:00:30Z",
          },
          {
            context: "validate-merge",
            state: "success",
            target_url: "https://github.com/fongap-labs/action-worker/actions/runs/1",
            created_at: "2026-09-25T00:00:40Z",
          },
        ],
      },
    ],
    [
      "repos/fongap-labs/action-worker/actions/runs/1",
      {
        repository: { full_name: "fongap-labs/action-worker" },
        path: ".github/workflows/handle-pr-dispatch.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-09-25T00:00:00Z",
        updated_at: "2026-09-25T00:01:00Z",
      },
    ],
    [
      "repos/fongap-labs/action-worker/actions/runs/2",
      {
        repository: { full_name: "fongap-labs/action-worker" },
        path: ".github/workflows/central-ci-dispatch.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-09-25T00:00:00Z",
        updated_at: "2026-09-25T00:01:00Z",
      },
    ],
    [
      "repos/fongap-labs/action-worker/actions/runs/3",
      {
        repository: { full_name: "fongap-labs/action-worker" },
        path: ".github/workflows/main-write-guard.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-09-25T00:00:00Z",
        updated_at: "2026-09-25T00:01:00Z",
      },
    ],
    [
      `repos/fongap/example/commits/${mainSha}/status`,
      {
        statuses: [
          {
            context: "Main Write Guard",
            state: "success",
            target_url: "https://github.com/fongap-labs/action-worker/actions/runs/3",
            created_at: "2026-09-25T00:00:50Z",
          },
        ],
      },
    ],
    [
      `repos/fongap/example/statuses/${mainSha}?per_page=100`,
      [
        {
          context: "Main Write Guard",
          state: "success",
          target_url: "https://github.com/fongap-labs/action-worker/actions/runs/3",
          created_at: "2026-09-25T00:00:50Z",
        },
      ],
    ],
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
  const forgedRun = {
    ...(paths.get("repos/fongap-labs/action-worker/actions/runs/2") as Record<string, unknown>),
    path: ".github/workflows/validate-ci.yml",
  };
  paths.set("repos/fongap-labs/action-worker/actions/runs/2", forgedRun);
  await assert.rejects(
    () => validateMainWriteProvenance(reader, "fongap/example", mainSha, true),
    /CI Evidence/
  );
  paths.set("repos/fongap-labs/action-worker/actions/runs/2", {
    ...forgedRun,
    path: ".github/workflows/central-ci-dispatch.yml",
  });
  assert.equal(provenance.pr_number, 7);
  assert.equal(provenance.pr_head_sha, prHeadSha);
  assert.equal(
    (await validateMainWriteProvenance(reader, "fongap/example", mainSha, false)).pr_number,
    7
  );
  assert.equal(
    (await assertTrustedMainWrite(reader, "fongap/example", mainSha, true)).main_sha,
    mainSha
  );
  assert.equal(
    await hasVerifiedMainWriteGuard(
      reader,
      paths.get(`repos/fongap/example/commits/${mainSha}/status`)
    ),
    true
  );

  // A gate status that names a run the control repository never held proves nothing.
  paths.set("repos/fongap-labs/action-worker/actions/runs/3", {
    ...(paths.get("repos/fongap-labs/action-worker/actions/runs/3") as Record<string, unknown>),
    path: ".github/workflows/validate-ci.yml",
  });
  assert.equal(
    await hasVerifiedMainWriteGuard(
      reader,
      paths.get(`repos/fongap/example/commits/${mainSha}/status`)
    ),
    false
  );
  paths.set("repos/fongap-labs/action-worker/actions/runs/3", {
    ...(paths.get("repos/fongap-labs/action-worker/actions/runs/3") as Record<string, unknown>),
    path: ".github/workflows/main-write-guard.yml",
  });

  // A failed guard names the SHA and says how main becomes trusted again.
  const failedGuard = [
    {
      context: "Main Write Guard",
      state: "failure",
      target_url: "https://github.com/fongap-labs/action-worker/actions/runs/3",
    },
  ];
  paths.set(`repos/fongap/example/commits/${mainSha}/status`, { statuses: failedGuard });
  paths.set(`repos/fongap/example/statuses/${mainSha}?per_page=100`, failedGuard);
  await assert.rejects(
    () => assertTrustedMainWrite(reader, "fongap/example", mainSha, true),
    (error: Error) =>
      error.message.includes(`fongap/example@${mainSha.slice(0, 12)}`) &&
      error.message.includes("merging a pull request that passed validate-merge")
  );
});

test("a newer in-progress main write attestation does not shadow an older verified one", async () => {
  const controlRepository = "fongap-labs/action-worker";
  const selfRunUrl = "https://github.com/fongap-labs/action-worker/actions/runs/9";
  const olderRunUrl = "https://github.com/fongap-labs/action-worker/actions/runs/3";
  const selfStatus = {
    context: "Main Write Guard",
    state: "success",
    target_url: selfRunUrl,
    created_at: "2026-09-25T00:02:10Z",
  };
  const status = {
    statuses: [
      // The deploy that is validating now attested its source seconds ago; it is still running.
      selfStatus,
      // Central CI completed its own attestation of the same immutable main write.
      {
        context: "Main Write Guard",
        state: "success",
        target_url: olderRunUrl,
        created_at: "2026-09-25T00:00:50Z",
      },
    ],
  };
  const paths = new Map<string, unknown>([
    [
      "repos/fongap-labs/action-worker/actions/runs/9",
      {
        repository: { full_name: controlRepository },
        path: ".github/workflows/deploy-source-script.yml",
        head_branch: "main",
        status: "in_progress",
        conclusion: null,
        run_started_at: "2026-09-25T00:02:00Z",
        updated_at: "2026-09-25T00:02:05Z",
      },
    ],
    [
      "repos/fongap-labs/action-worker/actions/runs/3",
      {
        repository: { full_name: controlRepository },
        path: ".github/workflows/central-ci-dispatch.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-09-25T00:00:00Z",
        updated_at: "2026-09-25T00:01:00Z",
      },
    ],
  ]);
  const requested: string[] = [];
  const reader = {
    get: async (path: string) => {
      requested.push(path);
      if (!paths.has(path)) throw new Error(`unexpected path: ${path}`);
      return paths.get(path);
    },
  } as unknown as GithubReader;

  const previousRunId = process.env.GITHUB_RUN_ID;
  process.env.GITHUB_RUN_ID = "9";
  try {
    assert.equal(await hasVerifiedMainWriteGuard(reader, status), true);
    // The asking run cannot verify itself, so its own attestation is never looked up.
    assert.deepEqual(requested, ["repos/fongap-labs/action-worker/actions/runs/3"]);
    // Only the asking run's own attestation is left: nothing independent proves the write yet.
    assert.equal(await hasVerifiedMainWriteGuard(reader, { statuses: [selfStatus] }), false);
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = previousRunId;
  }
});

test("a main write attestation outside its control run window names the rejected check", async () => {
  const controlRepository = "fongap-labs/action-worker";
  // The status was written long after the run that claims it had already ended.
  const status = {
    statuses: [
      {
        context: "Main Write Guard",
        state: "success",
        target_url: "https://github.com/fongap-labs/action-worker/actions/runs/3",
        created_at: "2026-09-26T00:00:00Z",
      },
    ],
  };
  const reader = {
    get: async (path: string) => {
      assert.equal(path, "repos/fongap-labs/action-worker/actions/runs/3");
      return {
        repository: { full_name: controlRepository },
        path: ".github/workflows/intake.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-09-25T00:00:00Z",
        updated_at: "2026-09-25T00:01:00Z",
      };
    },
  } as unknown as GithubReader;

  const steps: string[] = [];
  const previousRunId = process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ID;
  try {
    assert.equal(
      await hasVerifiedMainWriteGuard(reader, status, (step) => steps.push(step)),
      false
    );
  } finally {
    if (previousRunId !== undefined) process.env.GITHUB_RUN_ID = previousRunId;
  }
  assert.deepEqual(steps, ["run-outside-window"]);
});

test("a deploy's own attestation does not hide the Intake attestation of the same main write", async () => {
  const mainSha = "5".repeat(40);
  const prHeadSha = "6".repeat(40);
  const selfStatus = {
    context: "Main Write Guard",
    state: "success",
    target_url: "https://github.com/fongap-labs/action-worker/actions/runs/9",
    created_at: "2026-09-25T00:02:10Z",
  };
  const intakeStatus = {
    context: "Main Write Guard",
    state: "success",
    target_url: "https://github.com/fongap-labs/action-worker/actions/runs/3",
    created_at: "2026-09-25T00:00:50Z",
  };
  const paths = new Map<string, unknown>([
    ["repos/fongap/example", { default_branch: "main" }],
    [`repos/fongap/example/commits/${mainSha}`, { sha: mainSha }],
    [
      `repos/fongap/example/commits/${mainSha}/pulls?per_page=100`,
      [
        {
          number: 7,
          merged_at: "2026-09-25T00:00:00Z",
          merge_commit_sha: mainSha,
          base: { ref: "main" },
        },
      ],
    ],
    [
      "repos/fongap/example/pulls/7",
      {
        number: 7,
        merged_at: "2026-09-25T00:00:00Z",
        merge_commit_sha: mainSha,
        base: { ref: "main" },
        head: { sha: prHeadSha },
      },
    ],
    [
      `repos/fongap/example/commits/${prHeadSha}/check-runs?filter=latest&per_page=100`,
      {
        check_runs: [
          {
            name: "validate-merge",
            status: "completed",
            conclusion: "success",
            app: { slug: "github-actions" },
          },
        ],
      },
    ],
    // The combined endpoint keeps only the newest status per context: the deploy's own.
    [`repos/fongap/example/commits/${mainSha}/status`, { statuses: [selfStatus] }],
    // The full list keeps the earlier Intake attestation as well.
    [`repos/fongap/example/statuses/${mainSha}?per_page=100`, [selfStatus, intakeStatus]],
    [
      "repos/fongap-labs/action-worker/actions/runs/3",
      {
        repository: { full_name: "fongap-labs/action-worker" },
        path: ".github/workflows/intake.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-09-25T00:00:00Z",
        updated_at: "2026-09-25T00:01:00Z",
      },
    ],
  ]);
  const reader = {
    get: async (path: string) => {
      if (!paths.has(path)) throw new Error(`unexpected path: ${path}`);
      return paths.get(path);
    },
  } as unknown as GithubReader;

  const previousRunId = process.env.GITHUB_RUN_ID;
  process.env.GITHUB_RUN_ID = "9";
  try {
    const provenance = await assertTrustedMainWrite(reader, "fongap/example", mainSha, false);
    assert.equal(provenance.main_sha, mainSha);
    assert.equal(provenance.pr_number, 7);
  } finally {
    if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = previousRunId;
  }
});

test("main write provenance rejects direct pushes and fake status-only trust", async () => {
  const mainSha = "4".repeat(40);
  const paths = new Map<string, unknown>([
    ["repos/fongap/example", { default_branch: "main" }],
    [`repos/fongap/example/commits/${mainSha}`, { sha: mainSha }],
    [`repos/fongap/example/commits/${mainSha}/pulls?per_page=100`, []],
    [
      `repos/fongap/example/commits/${mainSha}/status`,
      {
        statuses: [
          {
            context: "Main Write Guard",
            state: "success",
            target_url: "https://github.com/fongap-labs/action-worker/actions/runs/9",
            created_at: "2026-09-25T00:00:20Z",
          },
        ],
      },
    ],
  ]);
  const reader = {
    get: async (path: string) => paths.get(path),
  } as unknown as GithubReader;

  // The status names a run the control repository never held, so it proves nothing.
  assert.equal(
    await hasVerifiedMainWriteGuard(
      reader,
      paths.get(`repos/fongap/example/commits/${mainSha}/status`)
    ),
    false
  );
  await assert.rejects(() => validateMainWriteProvenance(reader, "fongap/example", mainSha, false));
  await assert.rejects(() => assertTrustedMainWrite(reader, "fongap/example", mainSha, false));
});

test("PR review summary tells a maintainer how to release a pull request awaiting approval", () => {
  const body = buildReview("awaiting-approval", "https://example.test/run", undefined, undefined);
  assert.match(body, /Gate: \*\*WAITING FOR APPROVAL\*\*/);
  assert.match(body, /Review changes → Approve/);
  // The approval is the only step: nothing has to be started by hand afterwards.
  assert.match(body, /continues automatically after the approval/);
  // GitHub sends no event with secrets on an approval, so Intake notices it; the wait is not hidden.
  assert.match(body, /next Intake run, usually within an hour/);
  assert.doesNotMatch(body, /Actions tab|run \*\*/);
  assert.doesNotMatch(body, /Gate: \*\*FAIL\*\*/);
});
