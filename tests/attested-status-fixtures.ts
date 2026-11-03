import { originalStatusDescription, signedStatusDescription } from "../scripts/status-attestation.ts";

export const fixtureStatusToken = "action-worker-test-status-signing-key";
process.env.AW_STATUS_TOKEN = fixtureStatusToken;

export function attestFixtureStatus(
  status: Record<string, unknown>,
  repository: string,
  sha: string
): Record<string, unknown> {
  const context = status.context;
  const state = status.state;
  if (
    typeof context !== "string" ||
    !["pending", "success", "failure", "error"].includes(String(state)) ||
    !/^[0-9a-f]{40}$/.test(sha)
  ) return status;
  const rawDescription = typeof status.description === "string"
    ? status.description : `Fixture ${context}`;
  const description = originalStatusDescription(status) || rawDescription;
  const targetUrl = typeof status.target_url === "string" ? status.target_url : "";
  return {
    ...status,
    description: signedStatusDescription({
      repository,
      sha,
      context,
      state: state as "pending" | "success" | "failure" | "error",
      description,
      targetUrl,
    }, fixtureStatusToken),
  };
}

export function attestFixtureStatuses<T>(
  value: T,
  repository: string,
  sha: string
): T {
  if (Array.isArray(value)) {
    return value.map(item =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? attestFixtureStatus(item as Record<string, unknown>, repository, sha)
        : item
    ) as T;
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.statuses)) {
    return { ...record, statuses: attestFixtureStatuses(record.statuses, repository, sha) } as T;
  }
  return attestFixtureStatus(record, repository, sha) as T;
}

export function attestFixtureResponseForPath<T>(path: string, value: T): T {
  const match = /^repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:commits\/([0-9a-f]{40})\/status|statuses\/([0-9a-f]{40}))(?:\?|$)/.exec(path);
  if (!match) return value;
  return attestFixtureStatuses(value, match[1]!, (match[2] ?? match[3])!);
}
