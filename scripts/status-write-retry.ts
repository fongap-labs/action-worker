const transientWriteFailure =
  /(?:HTTP\s+)(?:408|429|500|502|503|504)\b|server error|bad gateway|service unavailable|gateway timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

export function isRetryableStatusWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return transientWriteFailure.test(message);
}

export async function retryTransientStatusWrite<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 3
): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("Status write retry attempts must be between 1 and 5.");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableStatusWriteError(error) || attempt + 1 >= attempts) throw error;
      await wait(250 * 2 ** attempt);
    }
  }
  throw new Error("Status write retry loop ended unexpectedly.");
}

/**
 * GitHub's create-commit-status endpoint returns HTTP 201. Do not require
 * the response body to be JSON: an empty/truncated success body must not turn
 * a confirmed HTTP 201 into a false permission failure.
 *
 * A status write still fails closed on any other status or exhausted retry
 * budget. Only the dedicated repository-scoped status token is used.
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
      throw new Error(
        `GitHub commit status POST for ${request.repository} failed: HTTP ${response.status}${permissionHint}${trace}.`
      );
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
