import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { GithubApiRequestAudit } from "../scripts/github-api-request-audit.ts";
import { GithubReader } from "../scripts/github-api.ts";

test("audited immutable reads count singleflight, conditional ETag, and actual 304", async () => {
  const previous = globalThis.fetch;
  const audit = new GithubApiRequestAudit();
  const sha = "a".repeat(40);
  const path = "repos/example/project/contents/.github/task-source.json?ref=" + sha;
  const conditions: string[] = [];
  globalThis.fetch = async (_url, options) => {
    conditions.push(new Headers(options?.headers).get("if-none-match") ?? "");
    return conditions.length === 1
      ? Response.json(
          { content: "valid" },
          {
            headers: {
              etag: '"sha1"',
              "x-ratelimit-resource": "core",
              "x-ratelimit-remaining": "4000",
            },
          }
        )
      : new Response(null, {
          status: 304,
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "3999",
          },
        });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "token", { audit });
    const [first, second] = await Promise.all([reader.get(path), reader.get(path)]);
    assert.deepEqual(first, { content: "valid" });
    assert.deepEqual(second, first);
    assert.deepEqual(await reader.get(path), first);
    assert.deepEqual(conditions, ["", '"sha1"']);
    assert.deepEqual(
      {
        fetch: audit.snapshot().fetch,
        not_modified: audit.snapshot().not_modified,
        conditional: audit.snapshot().conditional,
        coalesced: audit.snapshot().coalesced,
        core_min: audit.snapshot().core_min,
      },
      { fetch: 2, not_modified: 1, conditional: 1, coalesced: 1, core_min: 3999 }
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("audited retries count each HTTP attempt, never treating a retry as a cache hit", async () => {
  const previous = globalThis.fetch;
  const audit = new GithubApiRequestAudit();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : Response.json({ ok: true });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "token", {
      audit,
      attemptLimit: 2,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    assert.deepEqual(await reader.get("repos/example/project"), { ok: true });
    assert.equal(audit.snapshot().fetch, 2);
    assert.equal(audit.snapshot().server_errors, 1);
    assert.equal(audit.snapshot().ok, 1);
    assert.equal(audit.snapshot().retries, 1);
  } finally {
    globalThis.fetch = previous;
  }
});

test("audited 403 distinguishes exhausted primary rate quota from permissions", async () => {
  const previous = globalThis.fetch;
  const audit = new GithubApiRequestAudit();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? Response.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } }
        )
      : Response.json({ message: "Resource not accessible" }, { status: 403 });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "token", {
      audit,
      attemptLimit: 1,
    });
    await assert.rejects(() => reader.get("repos/example/one"), /primary API rate limit/);
    await assert.rejects(() => reader.get("repos/example/two"), /access forbidden/);
    assert.equal(audit.snapshot().forbidden, 2);
    assert.equal(audit.snapshot().primary_limit, 1);
    assert.equal(audit.snapshot().secondary_limit, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("CLI metrics recognize rate limits without exposing error strings or credentials", () => {
  const audit = new GithubApiRequestAudit();
  audit.cliStart();
  audit.cliFinish(new Error("gh: API rate limit exceeded for installation 123 (HTTP 403)"));
  audit.cliStart();
  audit.cliFinish(new Error("gh: Resource not accessible by token (HTTP 403)"));
  audit.cliStart();
  audit.cliFinish();
  audit.cliStart();
  audit.cliFinish(new Error("gh: secondary rate limit exceeded (HTTP 429)"));
  const snapshot = audit.snapshot();
  assert.equal(snapshot.cli, 4);
  assert.equal(snapshot.cli_failed, 3);
  assert.equal(snapshot.primary_limit, 1);
  assert.equal(snapshot.secondary_limit, 1);
  const summary = audit.summary("intake-main", "intake-main-ci.ts");
  assert.match(summary, /实际请求尝试/);
  assert.doesNotMatch(summary, /installation 123|token|Bearer|example\.com/);
  assert.match(audit.summary("<script>", "secret|file"), /unknown \/ unknown/);
});

test("all intake scan and preflight steps publish opt-in per-process GitHub API audit", async () => {
  const workflow = parse(await readFile(".github/workflows/intake.yml", "utf8")) as {
    jobs: Record<
      string,
      { steps: Array<{ run?: string; env?: Record<string, string> }> }
    >;
  };
  const scripts: Record<string, string> = {
    "pull-requests": "intake-open-prs.ts",
    "main-ci": "intake-main-ci.ts",
    "main-writes": "audit-main-writes.ts",
    "task-sources": "intake-task-sources.ts",
    "task-schedules": "dispatch-scheduled-tasks.ts",
    "deploy-schedules": "dispatch-scheduled-deploys.ts",
    "security-scans": "intake-security-scans.ts",
  };
  for (const [job, script] of Object.entries(scripts)) {
    const step = workflow.jobs[job]?.steps.find((item) => item.run === "node scripts/" + script);
    assert.equal(step?.env?.AW_GITHUB_API_METRICS, "1", job);
  }
  for (const job of ["task-sources", "task-schedules", "deploy-schedules"]) {
    const step = workflow.jobs[job]?.steps.find(
      (item) => item.run === "node scripts/check-github-api-budget.ts"
    );
    assert.equal(step?.env?.AW_GITHUB_API_METRICS, "1", job);
  }
  const raw = await readFile(".github/workflows/intake.yml", "utf8");
  assert.doesNotMatch(raw, /GitHub API.*upload-artifact|api-audit.*upload-artifact/);
});
