import { appendFileSync } from "node:fs";

/** Fixed, low-cardinality classifications; never persist or print request paths. */
export const githubApiEndpointCategories = [
  "repository",
  "branches",
  "commits",
  "pull_requests",
  "checks",
  "statuses",
  "actions_runs",
  "issues",
  "contents",
  "rate_limit",
  "other",
] as const;

export type GithubApiEndpointCategory = (typeof githubApiEndpointCategories)[number];

export function classifyGithubApiEndpoint(requestPath: string): GithubApiEndpointCategory {
  const normalized = requestPath
    .replace(/^https:\/\/api\.github\.com\//i, "")
    .replace(/^\/+/, "")
    .split(/[?#]/, 1)[0];
  if (normalized === "rate_limit") return "rate_limit";
  const parts = normalized?.split("/") ?? [];
  if (parts[0] !== "repos" || !parts[1] || !parts[2]) return "other";
  const section = parts[3] ?? "";
  if (section === "") return "repository";
  if (section === "branches") return "branches";
  if (section === "statuses") return "statuses";
  if (section === "checks" || section === "check-runs" || section === "check-suites") {
    return "checks";
  }
  if (section === "commits") {
    if (parts[5] === "status" || parts[5] === "statuses") return "statuses";
    if (parts[5] === "check-runs" || parts[5] === "check-suites") return "checks";
    if (parts[5] === "pulls") return "pull_requests";
    return "commits";
  }
  if (section === "pulls") return "pull_requests";
  if (section === "issues") return "issues";
  if (section === "contents") return "contents";
  if (section === "actions") return "actions_runs";
  return "other";
}

function emptyEndpointCounts(): Record<GithubApiEndpointCategory, number> {
  return {
    repository: 0,
    branches: 0,
    commits: 0,
    pull_requests: 0,
    checks: 0,
    statuses: 0,
    actions_runs: 0,
    issues: 0,
    contents: 0,
    rate_limit: 0,
    other: 0,
  };
}

export type GithubApiAuditSnapshot = {
  fetch: number;
  cli: number;
  cli_failed: number;
  ok: number;
  not_modified: number;
  forbidden: number;
  too_many: number;
  server_errors: number;
  other_http: number;
  transport: number;
  conditional: number;
  coalesced: number;
  retries: number;
  primary_limit: number;
  secondary_limit: number;
  core_min: number | null;
  endpoint_counts: Record<GithubApiEndpointCategory, number>;
};

/** Per-process aggregation only; never stores API URLs, tokens or response bodies. */
export class GithubApiRequestAudit {
  private readonly endpointCounts = emptyEndpointCounts();
  private readonly counts: Omit<GithubApiAuditSnapshot, "endpoint_counts"> = {
    fetch: 0,
    cli: 0,
    cli_failed: 0,
    ok: 0,
    not_modified: 0,
    forbidden: 0,
    too_many: 0,
    server_errors: 0,
    other_http: 0,
    transport: 0,
    conditional: 0,
    coalesced: 0,
    retries: 0,
    primary_limit: 0,
    secondary_limit: 0,
    core_min: null,
  };

  fetchStart(conditional: boolean, requestPath = ""): void {
    this.endpointCounts[classifyGithubApiEndpoint(requestPath)] += 1;
    this.counts.fetch += 1;
    if (conditional) this.counts.conditional += 1;
  }

  fetchResponse(status: number, headers: Headers): void {
    if (status === 304) this.counts.not_modified += 1;
    else if (status >= 200 && status < 300) this.counts.ok += 1;
    else if (status === 403) this.counts.forbidden += 1;
    else if (status === 429) this.counts.too_many += 1;
    else if (status >= 500) this.counts.server_errors += 1;
    else this.counts.other_http += 1;
    if (headers.get("x-ratelimit-resource") === "core") {
      const raw = headers.get("x-ratelimit-remaining");
      if (raw && /^\d+$/.test(raw)) {
        const remaining = Number(raw);
        if (Number.isSafeInteger(remaining)) {
          const old = this.counts.core_min;
          this.counts.core_min = old === null ? remaining : Math.min(old, remaining);
        }
      }
    }
  }

  fetchTransportError(): void {
    this.counts.transport += 1;
  }

  coalescedRequest(): void {
    this.counts.coalesced += 1;
  }

  retry(): void {
    this.counts.retries += 1;
  }

  rateLimited(kind: "primary-rate-limit" | "secondary-rate-limit"): void {
    if (kind === "primary-rate-limit") this.counts.primary_limit += 1;
    else this.counts.secondary_limit += 1;
  }

  cliStart(requestPath = ""): void {
    this.endpointCounts[classifyGithubApiEndpoint(requestPath)] += 1;
    this.counts.cli += 1;
  }

  cliFinish(error?: unknown): void {
    if (error === undefined) return;
    this.counts.cli_failed += 1;
    const message = error instanceof Error ? error.message : "";
    if (/(?:HTTP|status)\s+429\b/i.test(message)) {
      this.counts.secondary_limit += 1;
    } else if (/(?:HTTP|status)\s+403\b/i.test(message)) {
      if (/secondary rate limit|abuse detection|too many requests/i.test(message)) {
        this.counts.secondary_limit += 1;
      } else if (/API rate limit exceeded|primary rate limit/i.test(message)) {
        this.counts.primary_limit += 1;
      }
    }
  }

  snapshot(): GithubApiAuditSnapshot {
    return { ...this.counts, endpoint_counts: { ...this.endpointCounts } };
  }

  summary(job: string, script: string): string {
    const c = this.snapshot();
    const safe = (value: string): string =>
      /^[A-Za-z0-9_.-]{1,96}$/.test(value) ? value : "unknown";
    const remaining = c.core_min === null ? "未提供" : String(c.core_min);
    const endpointRows = githubApiEndpointCategories.map(
      (category) => `| ${category} | ${c.endpoint_counts[category]} |`
    );
    return [
      "### GitHub API 调用审计 · " + safe(job) + " / " + safe(script),
      "",
      "| 指标 | 次数 |",
      "|---|---:|",
      "| 实际请求尝试（HTTP + gh api） | " + (c.fetch + c.cli) + " |",
      "| fetch / gh api | " + c.fetch + " / " + c.cli + " |",
      "| HTTP 2xx / 304 | " + c.ok + " / " + c.not_modified + " |",
      "| 条件 GET / 并发去重免发请求 | " + c.conditional + " / " + c.coalesced + " |",
      "| 重试 / 传输异常 | " + c.retries + " / " + c.transport + " |",
      "| HTTP 403 / 429 / 5xx / 其他 | " +
        c.forbidden +
        " / " +
        c.too_many +
        " / " +
        c.server_errors +
        " / " +
        c.other_http +
        " |",
      "| 限流：主要 / 次级（含可识别 gh api 错误） | " +
        c.primary_limit +
        " / " +
        c.secondary_limit +
        " |",
      "| gh api 失败 | " + c.cli_failed + " |",
      "| 响应头 core 最低剩余额度 | " + remaining + " |",
      "",
      "#### GitHub API 端点分类",
      "| 固定类别 | 请求次数 |",
      "|---|---:|",
      ...endpointRows,
      "| 分类总计 | " + (c.fetch + c.cli) + " |",
      "",
      "统计范围仅限本进程 GithubReader 与统一 runCommand 的 gh api。" +
        "不包括其他 Job、未经封装的 CLI、Actions 平台内部请求；" +
        "304 仍是实际 HTTP 请求。仅记录聚合数字，不记录仓库路径或敏感内容。",
      "",
    ].join("\n");
  }
}

export const githubApiAudit = new GithubApiRequestAudit();

// Sync exit handler also captures early failures via handleError/process.exit.
// Observability must never weaken a release gate or leak paths/tokens.
if (process.env.AW_GITHUB_API_METRICS === "1") {
  process.once("exit", () => {
    const job = process.env.GITHUB_JOB ?? "unknown";
    const script = (process.argv[1] ?? "").split(/[\\/]/).at(-1) ?? "unknown";
    const stats = githubApiAudit.snapshot();
    console.log(
      "GitHub API requests: fetch=" +
        stats.fetch +
        " cli=" +
        stats.cli +
        " 304=" +
        stats.not_modified +
        " coalesced=" +
        stats.coalesced +
        " retries=" +
        stats.retries +
        " limits=" +
        (stats.primary_limit + stats.secondary_limit)
    );
    console.log(
      "GitHub API endpoint categories: " +
        githubApiEndpointCategories
          .map((category) => category + "=" + stats.endpoint_counts[category])
          .join(" ")
    );
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (path) {
      try {
        appendFileSync(path, githubApiAudit.summary(job, script) + "\n", "utf8");
      } catch {
        console.error("::warning::GitHub API audit summary could not be written.");
      }
    }
  });
}
