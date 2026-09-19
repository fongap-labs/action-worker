import {
  CliError,
  runCommand,
  runText,
} from "./runtime-command.ts";

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
  return error instanceof CliError && /(?:HTTP|status)\s+404\b/i.test(error.message);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

type ReaderOptions = {
  attemptLimit?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

class GithubHttpError extends Error {
  readonly retryAfterMs?: number;
  readonly status: number;

  constructor(status: number, retryAfterMs?: number) {
    super(`GitHub API returned HTTP ${status}.`);
    this.name = "GithubHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class GithubReader {
  readonly attemptLimit: number;
  readonly apiUrl: string;
  readonly retryDelayMs: number;
  readonly timeoutMs: number;
  readonly token: string;

  constructor(apiUrl: string, token: string, options: ReaderOptions = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
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
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attemptLimit; attempt += 1) {
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
        const response = await fetch(`${this.apiUrl}/${path.replace(/^\/+/, "")}`, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new GithubHttpError(
            response.status,
            parseRetryAfter(response.headers.get("retry-after")),
          );
        }
        return await response.json() as unknown;
      } catch (error) {
        lastError = error;
        const canRetry = !(error instanceof GithubHttpError)
          || isRetryableStatus(error.status)
          || (error.status === 403 && error.retryAfterMs !== undefined);
        if (!canRetry || attempt + 1 >= this.attemptLimit) {
          throw error;
        }
        const retryDelay = error instanceof GithubHttpError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : this.retryDelayMs * (2 ** attempt);
        await sleep(Math.min(retryDelay, 30_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}
