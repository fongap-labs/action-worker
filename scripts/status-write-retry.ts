const transientWriteFailure =
  /(?:HTTP\s+)(?:408|429|500|502|503|504)\b|server error|bad gateway|service unavailable|gateway timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;
const maximumRetryDelayMs = 60_000;

type RetryDelayError = Error & { retryAfterMs?: number };

export function isRetryableStatusWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return transientWriteFailure.test(message);
}

function serverRetryDelayMs(error: unknown, now = Date.now()): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const attached = (error as RetryDelayError).retryAfterMs;
  if (typeof attached === "number" && Number.isFinite(attached) && attached >= 0) return attached;

  const message = error.message;
  const retryAfter = message.match(/retry-after\s*[:=]\s*([^\r\n;]+)/i);
  if (retryAfter) {
    const value = retryAfter[1]?.trim();
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  }
  const reset = message.match(/x-ratelimit-reset\s*[:=]\s*(\d+)/i);
  if (reset) return Math.max(0, Number(reset[1]) * 1000 - now);
  return undefined;
}

export async function retryTransientStatusWrite<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 3,
  random: () => number = Math.random
): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("Status write retry attempts must be between 1 and 5.");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableStatusWriteError(error) || attempt + 1 >= attempts) throw error;
      const serverDelay = serverRetryDelayMs(error);
      // Do not retry early or sleep past this job's budget if GitHub requests a longer delay.
      if (serverDelay !== undefined && serverDelay > maximumRetryDelayMs) throw error;
      const baseDelay = 250 * 2 ** attempt;
      const jitter = Math.max(0, Math.min(1, random()));
      const localDelay = Math.floor(baseDelay * (0.5 + jitter));
      await wait(Math.max(localDelay, serverDelay ?? 0));
    }
  }
  throw new Error("Status write retry loop ended unexpectedly.");
}

export function responseRetryDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - now);
  return undefined;
}

/**
 * GitHub's create-commit-status endpoint returns HTTP 201. Do not require
 * the response body to be JSON: an empty/truncated success body must not turn
 * a confirmed HTTP 201 into a false permission failure.
 *
 * Only known transient responses are retried, with bounded exponential backoff,
 * jitter and server delay guidance. Permission and exhausted-budget failures stop.
 */
export async function postGithubCommitStatus(request: {
  repository: string;
  sha: string;
  token: string;
  state: "success" | "failure" | "pending" | "error";
  context: string;
  description: string;
  targetUrl?: string;
}): Promise<void> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
    !/^[0-9a-f]{40}$/.test(request.sha) ||
    !request.token ||
    !request.context ||
    !request.description
  ) {
    throw new Error("Invalid commit status request or missing dedicated status token.");
  }
  const apiUrl = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const url = `${apiUrl}/repos/${request.repository}/statuses/${request.sha}`;
  await retryTransientStatusWrite(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${request.token}`,
        },
        body: JSON.stringify({
          state: request.state,
          context: request.context,
          description: request.description,
          ...(request.targetUrl ? { target_url: request.targetUrl } : {}),
        }),
        signal: controller.signal,
      });
      if (response.status === 201) return;
      const requestId = response.headers.get("x-github-request-id");
      const permissionHint =
        response.status === 401 || response.status === 403
          ? "; verify GitHub App installation and Commit statuses: Write"
          : "";
      const trace = requestId ? `; request ID ${requestId}` : "";
      const error = new Error(
        `GitHub commit status POST for ${request.repository} failed: HTTP ${response.status}${permissionHint}${trace}.`
      ) as RetryDelayError;
      error.retryAfterMs = responseRetryDelayMs(response.headers);
      throw error;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("GitHub commit status POST timed out (ETIMEDOUT).");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}
