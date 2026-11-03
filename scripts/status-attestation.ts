import { createHmac, timingSafeEqual } from "node:crypto";
import { getJsonArray, getJsonString, isJsonRecord, type JsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

export type CommitStatus = {
  repository: string;
  sha: string;
  state: "pending" | "success" | "failure" | "error";
  context: string;
  description: string;
  targetUrl: string;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const signaturePattern = /(?:^| )\[aw1:([A-Za-z0-9_-]{43})\]$/;
const signatureSuffixLength = " [aw1:]".length + 43;

export function requireStatusToken(environment: NodeJS.ProcessEnv = process.env): string {
  const token = environment.AW_STATUS_TOKEN ?? "";
  if (!token) {
    throw new CliError(
      "::error::AW_STATUS_TOKEN is required to sign and publish commit statuses. No token fallback is permitted.",
      77
    );
  }
  return token;
}

function statusMessage(status: CommitStatus): string {
  return JSON.stringify([
    "action-worker-status-v1",
    status.repository.toLowerCase(),
    status.sha.toLowerCase(),
    status.context,
    status.state,
    status.description,
    status.targetUrl,
  ]);
}

function signature(status: CommitStatus, token: string): string {
  return createHmac("sha256", token).update(statusMessage(status)).digest("base64url");
}

export function originalStatusDescription(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const description = (value as Record<string, unknown>).description;
  if (typeof description !== "string") return "";
  const match = signaturePattern.exec(description);
  return match ? description.slice(0, match.index).trimEnd() : "";
}

export function signedStatusDescription(status: CommitStatus, token: string): string {
  const description = status.description.trimEnd().slice(0, 140 - signatureSuffixLength).trimEnd();
  if (!description) {
    throw new CliError("::error::Commit status description is empty after signing.", 64);
  }
  const signedStatus = { ...status, description };
  return `${description} [aw1:${signature(signedStatus, token)}]`;
}

export function hasValidStatusAttestation(
  value: unknown,
  subject: { repository: string; sha: string; context: string },
  token: string
): boolean {
  if (!token || !repositoryPattern.test(subject.repository) || !shaPattern.test(subject.sha)) {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  const state = status.state;
  const context = status.context;
  const description = status.description;
  const targetUrl = typeof status.target_url === "string" ? status.target_url : "";
  if (
    typeof state !== "string" ||
    !["pending", "success", "failure", "error"].includes(state) ||
    context !== subject.context ||
    typeof description !== "string"
  ) {
    return false;
  }
  const match = signaturePattern.exec(description);
  if (!match?.[1]) return false;
  const signedDescription = description.slice(0, match.index).trimEnd();
  const statusInput: CommitStatus = {
    repository: subject.repository,
    sha: subject.sha,
    context: subject.context,
    state: state as CommitStatus["state"],
    description: signedDescription,
    targetUrl,
  };
  const expected = Buffer.from(signature(statusInput, token), "base64url");
  const actual = Buffer.from(match[1], "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function latestAttestedStatus(
  response: unknown,
  subject: { repository: string; sha: string; context: string },
  token: string
): JsonRecord | undefined {
  const latest = getJsonArray(response, "statuses")
    .filter(isJsonRecord)
    .filter((status) => getJsonString(status, "context") === subject.context)
    .sort((left, right) =>
      getJsonString(right, "created_at").localeCompare(getJsonString(left, "created_at"))
    )[0];
  return latest && hasValidStatusAttestation(latest, subject, token) ? latest : undefined;
}
