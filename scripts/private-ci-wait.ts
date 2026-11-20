import { setTimeout as delay } from "node:timers/promises";
import { GithubHttpError, isRetryableStatus } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Reader = { get(path: string): Promise<unknown> };

const immutablePrivateEvidencePath =
  /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:git\/commits\/[a-f0-9]{40}|contents\/[^?]+\?ref=[a-f0-9]{40})$/;

/**
 * Cache only commit-bound Git objects within one verification process.
 * Never cache the live PR, repository settings, workflow runs or jobs:
 * these must be re-read at each attempt, including after a quota reset.
 */
export function cacheImmutablePrivateEvidence(reader: Reader): Reader {
  const immutable = new Map<string, unknown>();
  return {
    async get(path: string): Promise<unknown> {
      if (!immutablePrivateEvidencePath.test(path)) return await reader.get(path);
      if (immutable.has(path)) return immutable.get(path);
      const result = await reader.get(path);
      immutable.set(path, result);
      return result;
    },
  };
}

export type PrivateCiWaitOptions = {
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

function boundedWaitMs(error: unknown, pollMs: number, now: number): number {
  if (error instanceof GithubHttpError) {
    if (
      error.kind === "permission" ||
      (error.kind === "http" && !isRetryableStatus(error.status))
    ) {
      throw error;
    }
    if (error.kind === "primary-rate-limit") {
      if (error.resetAtMs === undefined || error.resetAtMs <= 0) {
        throw new CliError(
          "Native private CI verification paused: GitHub primary quota reset unavailable.",
          75
        );
      }
      return Math.max(pollMs, error.resetAtMs - now + 2_000);
    }
    return Math.max(pollMs, error.retryAfterMs ?? 0);
  }
  // A not-yet-complete source run is a legitimate transient state.
  // Invalid CLI input, source permissions and unexpected failures are not.
  if (!(error instanceof CliError) || error.exitCode !== 65) throw error;
  return pollMs;
}

/**
 * Do not return success until the verifier accepts the exact current base/head,
 * merge parentage, verified caller and every required source-owned job.
 * A timeout or exhausted API quota never becomes a green check.
 */
export async function waitForPrivateCiEvidence<T>(
  verify: () => Promise<T>,
  options: PrivateCiWaitOptions
): Promise<T> {
  const { timeoutMs, pollMs } = options;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(pollMs) ||
    timeoutMs < 1_000 ||
    pollMs < 1_000 ||
    pollMs >= timeoutMs
  ) {
    throw new CliError("Invalid native private CI verification wait budget.", 64);
  }
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? ((ms: number) => delay(ms));
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  if (!Number.isSafeInteger(deadline)) {
    throw new CliError("Invalid native private CI verification clock.", 64);
  }

  for (;;) {
    try {
      return await verify();
    } catch (error) {
      const current = now();
      const durationMs = boundedWaitMs(error, pollMs, current);
      if (durationMs <= 0 || current + durationMs >= deadline) {
        throw new CliError(
          error instanceof GithubHttpError && error.kind === "primary-rate-limit"
            ? "Native private CI verification blocked by GitHub API quota beyond the allowed window."
            : "Native private CI evidence did not pass within the bounded verification window.",
          65
        );
      }
      // Do not hammer the App installation with rapid fresh PR/CI queries.
      console.log(
        `Native private CI evidence pending; next bounded verification in ${Math.ceil(durationMs / 1000)} seconds.`
      );
      await pause(durationMs);
    }
  }
}
