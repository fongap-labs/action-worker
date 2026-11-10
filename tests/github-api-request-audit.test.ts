import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { GithubReader } from "../scripts/github-api.ts";
import {
  classifyGithubApiEndpoint,
  GithubApiRequestAudit,
  githubApiEndpointCategories,
} from "../scripts/github-api-request-audit.ts";

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
    jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }>;
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

test("fixed endpoint categories cover GitHub REST route families without leaking identities", () => {
  const sha = "a".repeat(40);
  for (const [path, expected] of [
    ["repos/fongap-labs/private-project", "repository"],
    ["repos/fongap-labs/private-project/branches/main", "branches"],
    ["repos/fongap-labs/private-project/commits/main", "commits"],
    ["repos/fongap-labs/private-project/commits?per_page=1", "commits"],
    ["repos/fongap-labs/private-project/commits/" + sha + "/pulls?per_page=100", "pull_requests"],
    ["repos/fongap-labs/private-project/pulls/123", "pull_requests"],
    ["repos/fongap-labs/private-project/commits/" + sha + "/check-runs?filter=latest", "checks"],
    ["repos/fongap-labs/private-project/commits/" + sha + "/status", "statuses"],
    ["repos/fongap-labs/private-project/statuses/" + sha, "statuses"],
    ["repos/fongap-labs/private-project/actions/runs/321", "actions_runs"],
    ["https://api.github.com/repos/fongap-labs/private-project/issues?state=open", "issues"],
    ["repos/fongap-labs/private-project/contents/.github/secret?ref=" + sha, "contents"],
    ["/rate_limit", "rate_limit"],
    ["graphql", "other"],
    ["https://elsewhere.test/repos/fongap-labs/private-project", "other"],
  ] as const) {
    assert.equal(classifyGithubApiEndpoint(path), expected, path);
  }
  assert.equal(new Set(githubApiEndpointCategories).size, githubApiEndpointCategories.length);
});

test("endpoint counts classify actual HTTP and CLI attempts, but not cache coalescing", () => {
  const audit = new GithubApiRequestAudit();
  audit.fetchStart(false, "repos/secret-org/private-repo");
  audit.fetchStart(true, "repos/secret-org/private-repo/commits/a/status");
  audit.fetchStart(false, "repos/secret-org/private-repo/actions/runs/421");
  audit.coalescedRequest();
  audit.cliStart("repos/secret-org/private-repo/issues/32");
  audit.cliFinish();
  audit.cliStart("unknown-endpoint?token=SHOULD_NOT_APPEAR");
  const snapshot = audit.snapshot();
  assert.equal(snapshot.fetch + snapshot.cli, 5);
  assert.deepEqual(
    {
      repository: snapshot.endpoint_counts.repository,
      statuses: snapshot.endpoint_counts.statuses,
      actions_runs: snapshot.endpoint_counts.actions_runs,
      issues: snapshot.endpoint_counts.issues,
      other: snapshot.endpoint_counts.other,
    },
    { repository: 1, statuses: 1, actions_runs: 1, issues: 1, other: 1 }
  );
  assert.equal(snapshot.coalesced, 1);
  assert.equal(
    githubApiEndpointCategories.reduce(
      (sum, category) => sum + snapshot.endpoint_counts[category],
      0
    ),
    snapshot.fetch + snapshot.cli
  );
  const table = audit.summary("main-writes", "audit-main-writes.ts");
  assert.match(table, /GitHub API 端点分类/);
  assert.match(table, /分类总计 \| 5/);
  assert.doesNotMatch(table, /secret-org|private-repo|SHOULD_NOT_APPEAR|421/);
  snapshot.endpoint_counts.repository = 500;
  assert.equal(audit.snapshot().endpoint_counts.repository, 1, "snapshots must be independent");
});

test("reader HTTP retries contribute to the same fixed endpoint family", async () => {
  const previous = globalThis.fetch;
  const audit = new GithubApiRequestAudit();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("temporary", { status: 503 })
      : Response.json({ ok: true });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "token", {
      audit,
      attemptLimit: 2,
      retryDelayMs: 0,
    });
    await reader.get("repos/example/project/actions/runs/123");
    assert.equal(audit.snapshot().endpoint_counts.actions_runs, 2);
    assert.equal(audit.snapshot().retries, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
