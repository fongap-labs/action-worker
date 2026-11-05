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
