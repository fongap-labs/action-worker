import { createHash } from "node:crypto";

export type CiFailureIdentity = {
  targetRepository: string;
  workflow: string;
  job: string;
  step: string;
  errorKind: string;
  sourceSha: string;
  repairOperation: string;
};

export type CiFailureFinding = {
  job: string;
  step: string;
  kind: string;
  recoverability: "safe_retry" | "do_not_retry" | "unknown";
  evidence: "job_log" | "step_name" | "unavailable";
};

export type CiFailureMarker = {
  retryable: boolean;
  retryAfterSeconds: number;
  fingerprint: string;
};

export const maxCiFailureAttempts = 3;
export const maxCiServerRetryAfterSeconds = 86_400;
const digestLength = 62;

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, digestLength);
}

/** Hashes only stable failure facts; timestamps and request IDs are deliberately excluded. */
export function ciFailureFingerprint(identity: CiFailureIdentity): string {
  return digest([
    "action-worker-ci-failure-v1",
    normalized(identity.targetRepository),
    normalized(identity.workflow),
    normalized(identity.job),
    normalized(identity.step),
    normalized(identity.errorKind),
    identity.sourceSha.toLowerCase(),
    normalized(identity.repairOperation),
  ]);
}

/** Parse server retry guidance from the bounded error lines retained for classification. */
export function serverRetryAfterSeconds(errorText: string, nowMs = Date.now()): number | undefined {
  const delays: number[] = [];
  for (const retryAfter of errorText.matchAll(/retry-after\s*[:=]\s*([^\r\n;]+)/gi)) {
    const value = retryAfter[1]?.trim();
    if (!value) continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      delays.push(Math.ceil(seconds));
      continue;
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) delays.push(Math.max(0, Math.ceil((date - nowMs) / 1_000)));
  }
  for (const reset of errorText.matchAll(/x-ratelimit-reset\s*[:=]\s*(\d+)/gi)) {
    if (reset[1]) {
      delays.push(Math.max(0, Math.ceil((Number(reset[1]) * 1_000 - nowMs) / 1_000)));
    }
  }
  return delays.length ? delays.reduce((largest, delay) => Math.max(largest, delay), 0) : undefined;
}

/** Creates the signed status marker consumed by intake. Retry is allowed only with log evidence. */
export function ciFailureMarker(
  findings: readonly CiFailureFinding[],
  context: Omit<CiFailureIdentity, "job" | "step" | "errorKind">,
  errorText = ""
): string {
  const effectiveFindings = findings.length
    ? findings
    : [
        {
          job: "unknown",
          step: "unknown",
          kind: "unknown",
          recoverability: "unknown" as const,
          evidence: "unavailable" as const,
        },
      ];
  const retryAfterSeconds = serverRetryAfterSeconds(errorText) ?? 0;
  const retryable =
    retryAfterSeconds <= maxCiServerRetryAfterSeconds &&
    effectiveFindings.every(
      (finding) => finding.recoverability === "safe_retry" && finding.evidence === "job_log"
    );
  const parts = effectiveFindings
    .map((finding) =>
      ciFailureFingerprint({
        ...context,
        job: finding.job,
        step: finding.step,
        errorKind: finding.kind,
      })
    )
    .sort();
  const fingerprint = digest(["action-worker-ci-failure-set-v1", [...new Set(parts)]]);
  return retryable ? `R${retryAfterSeconds}:${fingerprint}` : `N:${fingerprint}`;
}

export function parseCiFailureMarker(description: string): CiFailureMarker | null {
  const retryable = /^R(\d{1,5}):([0-9a-f]{62})$/.exec(description);
  if (retryable) {
    const retryAfterSeconds = Number(retryable[1]);
    if (retryAfterSeconds > maxCiServerRetryAfterSeconds) return null;
    return { retryable: true, retryAfterSeconds, fingerprint: retryable[2]! };
  }
  const permanent = /^N:([0-9a-f]{62})$/.exec(description);
  return permanent ? { retryable: false, retryAfterSeconds: 0, fingerprint: permanent[1]! } : null;
}

/** Applies a bounded exponential delay plus stable per-fingerprint jitter and server guidance. */
export function ciFailureRetryDelayMs(
  failureCount: number,
  fingerprint: string,
  retryAfterSeconds: number
): number {
  const attempt = Math.max(1, Math.min(maxCiFailureAttempts, Math.floor(failureCount)));
  const exponentialMs = Math.min(30 * 60_000, 5 * 60_000 * 2 ** (attempt - 1));
  const jitterByte = Number.parseInt(fingerprint.slice(0, 2), 16);
  const jitterMs = Math.floor((jitterByte / 255) * 60_000);
  return Math.max(exponentialMs + jitterMs, retryAfterSeconds * 1_000);
}
