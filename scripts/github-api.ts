import { type GithubApiCredential, githubApiAudit } from "./github-api-request-audit.ts";
import { sleep } from "./lib/promise-delay-runtime.ts";
import { CliError, runCommand, runText } from "./runtime-command.ts";

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getJsonString(value: unknown, key: string): string {
  return isJsonRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

export function getJsonNumber(value: unknown, key: string): number {
  return isJsonRecord(value) && typeof value[key] === "number" ? value[key] : 0;
}

export function getJsonArray(value: unknown, key?: string, exitCode = 65): unknown[] {
  const selected = key && isJsonRecord(value) ? value[key] : value;
  if (!Array.isArray(selected)) {
    throw new CliError("GitHub API returned an invalid response.", exitCode);
  }
  return selected;
}

export function decodeGithubContent(
  value: unknown,
  errorMessage = "GitHub contents response is invalid."
): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError(errorMessage, 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

export function githubEnvironment(token: string): NodeJS.ProcessEnv {
  return { ...process.env, GH_TOKEN: token };
}

export async function runGithubCli(args: readonly string[], token: string): Promise<string> {
  return await runText("gh", args, { env: githubEnvironment(token) });
}

export async function getGithubJson(path: string, token: string): Promise<unknown> {
  return JSON.parse(await runGithubCli(["api", path], token)) as unknown;
}

export async function githubExists(path: string, token: string): Promise<boolean> {
  try {
    await runCommand("gh", ["api", path], {
      env: githubEnvironment(token),
      maxBuffer: 1024 * 1024,
      timeoutMs: 30_000,
    });
    return true;
  } catch (error) {
    if (isGithubMissing(error)) {
      return false;
    }
    throw error;
  }
}

export function isGithubMissing(error: unknown): boolean {
  return (
    (error instanceof CliError && /(?:HTTP|status)\s+404\b/i.test(error.message)) ||
    (error instanceof GithubHttpError && error.status === 404)
  );
}

/** A manifest is absent only on a real HTTP 404; all other failures propagate. */
export async function getGithubJsonIfExists(
  path: string,
  get: (path: string) => Promise<unknown>
): Promise<unknown | undefined> {
  try {
    return await get(path);
  } catch (error) {
    if (isGithubMissing(error)) return undefined;
    throw error;
  }
}

type RateLimitState = { cooldown?: { error: GithubHttpError; until: number } };

type ReaderOptions = {
  credential?: GithubApiCredential;
  primaryLimit?: RateLimitState;
  secondaryLimit?: RateLimitState;
  attemptLimit?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  audit?: typeof githubApiAudit;
};

export type GithubFailureKind =
  | "primary-rate-limit"
  | "secondary-rate-limit"
  | "permission"
  | "plan-restriction"
  | "http";

export function classifyGithubFailure(
  status: number,
  headers: Headers,
  message: string
): GithubFailureKind {
  if (status !== 403 && status !== 429) return "http";
  if (/secondary rate limit|abuse detection|too many requests/i.test(message))
    return "secondary-rate-limit";
  if (headers.get("x-ratelimit-remaining") === "0" || /API rate limit exceeded/i.test(message)) {
    return "primary-rate-limit";
  }
  if (status === 429 || headers.has("retry-after")) return "secondary-rate-limit";
  if (
    status === 403 &&
    /^Upgrade to GitHub (?:Pro|Team|Enterprise) or make this repository public to enable this feature\.?$/i.test(
      message
    )
  ) {
    return "plan-restriction";
  }
  return "permission";
}

function rateLimitReset(headers: Headers): number | undefined {
  const raw = headers.get("x-ratelimit-reset");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const millis = Number(raw) * 1000;
  return Number.isSafeInteger(millis) ? millis : undefined;
}

export class GithubHttpError extends Error {
  readonly retryAfterMs?: number;
  readonly resetAtMs?: number;
  readonly status: number;
  readonly kind: GithubFailureKind;
  readonly requestId?: string;

  constructor(
    status: number,
    retryAfterMs?: number,
    details: {
      path?: string;
      kind?: GithubFailureKind;
      resetAtMs?: number;
      requestId?: string;
    } = {}
  ) {
    const kind = details.kind ?? "http";
    const where =
      details.path && (status === 403 || status === 429) ? ` on GET ${details.path}` : "";
    const explanation =
      kind === "primary-rate-limit"
        ? "primary API rate limit exhausted"
        : kind === "secondary-rate-limit"
          ? "secondary API rate limit"
          : kind === "permission"
            ? "access forbidden; check token repository permissions and SSO"
            : kind === "plan-restriction"
              ? "repository plan does not support this feature"
              : "";
    const reset =
      kind === "primary-rate-limit" && details.resetAtMs
        ? `; reset at ${new Date(details.resetAtMs).toISOString()}`
        : "";
    const request = details.requestId ? `; request ID ${details.requestId}` : "";
    super(
      `GitHub API returned HTTP ${status}${where}${explanation ? `: ${explanation}` : ""}${reset}${request}.`
    );
    this.name = "GithubHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.resetAtMs = details.resetAtMs;
    this.kind = kind;
    this.requestId = details.requestId;
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - now);
}

export function githubCoreReserve(limit: number): number {
  return Math.ceil(limit / 5);
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Only immutable, exact-SHA commit and content reads are eligible.
 * Dynamic PR/CI/status reads must always be fresh. Caches never cross credentials.
 */
function immutableGithubPath(path: string): boolean {
  const normalized = path.replace(/^\/+/, "");
  return (
    /^repos\/[^/?]+\/[^/?]+\/commits\/[a-f0-9]{40}$/.test(normalized) ||
    /^repos\/[^/?]+\/[^/?]+\/contents\/[^?]+\?ref=[a-f0-9]{40}$/.test(normalized)
  );
}

type ImmutableCacheEntry = { etag: string; value: unknown };
const maxImmutableEntries = 64;

export class GithubReader {
  private readonly audit: typeof githubApiAudit;
  private readonly immutableCache = new Map<string, ImmutableCacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly credential: GithubApiCredential;
  private readonly primaryLimit: RateLimitState;
  private readonly secondaryLimit: RateLimitState;
  readonly attemptLimit: number;
  readonly apiUrl: string;
  readonly retryDelayMs: number;
  readonly timeoutMs: number;
  readonly token: string;

  constructor(apiUrl: string, token: string, options: ReaderOptions = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.audit = options.audit ?? githubApiAudit;
    this.credential = options.credential ?? "unclassified";
    this.primaryLimit = options.primaryLimit ?? {};
    this.secondaryLimit = options.secondaryLimit ?? {};
    this.token = token;
    this.attemptLimit = options.attemptLimit ?? 4;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.attemptLimit) || this.attemptLimit < 1) {
      throw new CliError("GitHub API attempt limit must be a positive integer.");
    }
    if (this.retryDelayMs < 0 || this.timeoutMs < 1) {
      throw new CliError("GitHub API timing options are invalid.");
    }
  }

  async get(path: string): Promise<unknown> {
    if (!immutableGithubPath(path)) {
      return await this.fetchJson(path, false);
    }
    const pending = this.inFlight.get(path);
    if (pending) {
      this.audit.coalescedRequest();
      return await pending;
    }
    const request = this.fetchJson(path, true);
    this.inFlight.set(path, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(path);
    }
  }

  private async fetchJson(path: string, immutable: boolean): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attemptLimit; attempt += 1) {
      for (const limit of [this.secondaryLimit, this.primaryLimit]) {
        if (limit.cooldown && Date.now() < limit.cooldown.until) {
          throw limit.cooldown.error;
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.token) {
          headers.Authorization = `Bearer ${this.token}`;
        }
        const cached = immutable ? this.immutableCache.get(path) : undefined;
        if (cached) headers["If-None-Match"] = cached.etag;
        this.audit.fetchStart(Boolean(cached), path, this.credential);
        let response: Response;
        try {
          response = await fetch(`${this.apiUrl}/${path.replace(/^\/+/, "")}`, {
            headers,
            signal: controller.signal,
          });
        } catch (error) {
          this.audit.fetchTransportError();
          throw error;
        }
        this.audit.fetchResponse(response.status, response.headers, this.credential);
        if (response.status === 304 && cached) {
          return cached.value;
        }
        if (!response.ok) {
          // Distinguish exhausted quotas from missing permissions without exposing credentials.
          const body = (await response.text().catch(() => "")).slice(0, 4096);
          let githubMessage = "";
          try {
            const parsed: unknown = JSON.parse(body);
            githubMessage = getJsonString(parsed, "message");
          } catch {
            // Headers alone can still identify primary/secondary rate limits.
          }
          const kind = classifyGithubFailure(response.status, response.headers, githubMessage);
          if (kind === "primary-rate-limit" || kind === "secondary-rate-limit") {
            this.audit.rateLimited(kind);
          }
          const resetAtMs =
            kind === "primary-rate-limit" || response.headers.get("x-ratelimit-remaining") === "0"
              ? rateLimitReset(response.headers)
              : undefined;
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          const safePath = `/${(path.startsWith("/") ? path.slice(1) : path).split("?")[0]}`;
          throw new GithubHttpError(response.status, retryAfterMs, {
            path: safePath,
            kind,
            resetAtMs,
            requestId: response.headers.get("x-github-request-id") ?? undefined,
          });
        }
        const value: unknown = await response.json();
        if (immutable) {
          const etag = response.headers.get("etag");
          if (etag && etag.length <= 256) {
            this.immutableCache.delete(path);
            this.immutableCache.set(path, { etag, value });
            if (this.immutableCache.size > maxImmutableEntries) {
              const oldest = this.immutableCache.keys().next().value;
              if (oldest !== undefined) this.immutableCache.delete(oldest);
            }
          } else {
            this.immutableCache.delete(path);
          }
        }
        return value;
      } catch (error) {
        lastError = error;
        let retryDelay = this.retryDelayMs * 2 ** attempt;
        if (error instanceof GithubHttpError) {
          if (error.kind === "primary-rate-limit" || error.kind === "secondary-rate-limit") {
            const now = Date.now();
            retryDelay =
              error.kind === "primary-rate-limit"
                ? Math.max(0, (error.resetAtMs ?? Number.POSITIVE_INFINITY) - now) + 250
                : Math.max(
                    error.retryAfterMs ?? 60_000,
                    error.resetAtMs === undefined ? 0 : error.resetAtMs - now
                  );
            const until = now + retryDelay;
            const limit =
              error.kind === "primary-rate-limit" ? this.primaryLimit : this.secondaryLimit;
            if (!limit.cooldown || limit.cooldown.until < until) {
              limit.cooldown = { error, until };
            }
          } else if (!isRetryableStatus(error.status)) {
            throw error;
          } else {
            retryDelay = error.retryAfterMs ?? retryDelay;
          }
        }
        if (attempt + 1 >= this.attemptLimit || retryDelay > 30_000) throw error;
        this.audit.retry();
        await sleep(retryDelay);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

type NativeRepositoryRead = { repository: string; token: string };

function nativeRepositoryPath(path: string, repository: string): boolean {
  const parts = path.split("?", 1)[0]?.split("/") ?? [];
  if (
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..") ||
    parts.slice(0, 3).join("/") !== `repos/${repository}`
  ) {
    return false;
  }
  const endpoint = parts.slice(3).join("/");
  return (
    endpoint === "" ||
    /^(?:commits|pulls|branches|issues|statuses|contents|compare)(?:\/|$)/.test(endpoint) ||
    /^actions\/runs(?:\/|$)/.test(endpoint) ||
    /^(?:check-runs|check-suites)(?:\/|$)/.test(endpoint)
  );
}

/** Explicit local read delegation; status publication and cross-repository credentials are unchanged. */
export function statusAwareReader(
  apiUrl: string,
  controlToken: string,
  statusToken: string,
  native: NativeRepositoryRead = {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.AW_NATIVE_TOKEN ?? "",
  }
): GithubReader {
  if (!controlToken || !statusToken) {
    throw new CliError(
      "AW_CONTROL_TOKEN and AW_STATUS_API_TOKEN are both required; no token fallback is permitted.",
      77
    );
  }
  const primaryLimit: RateLimitState = {};
  const secondaryLimit: RateLimitState = {};
  const appOptions: ReaderOptions = { credential: "app", primaryLimit, secondaryLimit };
  const controlReader = new GithubReader(apiUrl, controlToken, appOptions);
  const statusReader = new GithubReader(apiUrl, statusToken, appOptions);
  const statusPath =
    /^repos\/[^/]+\/[^/]+\/(?:statuses\/[^/?]+|commits\/[^/?]+\/status(?:es)?)(?:\?|$)/;
  const readControlPath = controlReader.get.bind(controlReader);
  const nativeReader =
    native.token && native.repository
      ? new GithubReader(apiUrl, native.token, { credential: "native", secondaryLimit })
      : undefined;
  let nativeResetAt = 0;
  controlReader.get = async (path) => {
    if (
      nativeReader &&
      Date.now() >= nativeResetAt &&
      nativeRepositoryPath(path, native.repository)
    ) {
      try {
        return await nativeReader.get(path);
      } catch (error) {
        if (!(error instanceof GithubHttpError) || error.kind !== "primary-rate-limit") {
          throw error;
        }
        nativeResetAt = error.resetAtMs ?? Number.POSITIVE_INFINITY;
        githubApiAudit.nativeFallback();
        console.log("::notice::Native repository API quota exhausted; using scoped App reads.");
      }
    }
    return statusPath.test(path) ? statusReader.get(path) : readControlPath(path);
  };
  return controlReader;
}
