import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { getJsonArray, getJsonString, isJsonRecord, type JsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";
import { parseStatusSigningKeys } from "./status-signing-keys.ts";

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
const signaturePattern =
  /(?:^| )\[(?:aw1:|aw2:([A-Za-z0-9_-]{1,12}):([1-9][0-9]{0,5}):)([A-Za-z0-9_-]{43})\]$/;

// A closed migration receipt binds an individually verified pre-signing status. It is not a
// date-based exemption: a different status ID, subject, verdict or payload cannot reuse it.
const migration: unknown = JSON.parse(
  readFileSync(new URL("../policies/status-migration.json", import.meta.url), "utf8")
);
if (
  !isJsonRecord(migration) ||
  migration.schema_version !== 1 ||
  !Number.isFinite(Date.parse(getJsonString(migration, "recorded_before"))) ||
  !Array.isArray(migration.fingerprints) ||
  !migration.fingerprints.every(
    (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
  )
) {
  throw new CliError("::error::Invalid commit status migration receipts.", 65);
}
const migrationCutoff = Date.parse(getJsonString(migration, "recorded_before"));
const migrationFingerprints = new Set(migration.fingerprints as string[]);

function hasMigrationReceipt(
  status: Record<string, unknown>,
  subject: { repository: string; sha: string; context: string }
): boolean {
  const createdAt = getJsonString(status, "created_at");
  if (
    status.state !== "success" ||
    !Number.isSafeInteger(status.id) ||
    Number(status.id) <= 0 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    Date.parse(createdAt) >= migrationCutoff
  )
    return false;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "action-worker-status-migration-v1",
        subject.repository.toLowerCase(),
        subject.sha.toLowerCase(),
        subject.context,
        status.state,
        status.description,
        getJsonString(status, "target_url"),
        status.id,
        createdAt,
      ])
    )
    .digest("hex");
  return migrationFingerprints.has(fingerprint);
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

export function originalStatusDescription(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const description = (value as Record<string, unknown>).description;
  if (typeof description !== "string") return "";
  const match = signaturePattern.exec(description);
  return match ? description.slice(0, match.index).trimEnd() : "";
}

export function signedStatusDescription(status: CommitStatus): string {
  const keys = parseStatusSigningKeys(process.env.AW_STATUS_KEYRING ?? "");
  if (!keys)
    throw new CliError("::error::AW_STATUS_KEYRING is required to sign commit statuses.", 77);
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  if (!/^[1-9][0-9]{0,5}$/.test(attempt))
    throw new CliError("Invalid GitHub run attempt for status signing.", 65);
  const prefix = `aw2:${keys.active}:${attempt}:`;
  const signatureSuffixLength = ` [${prefix}]`.length + 43;
  const description = status.description
    .trimEnd()
    .slice(0, 140 - signatureSuffixLength)
    .trimEnd();
  if (!description) {
    throw new CliError("::error::Commit status description is empty after signing.", 64);
  }
  const signedStatus = { ...status, description };
  const digest = createHmac("sha256", keys.keys[keys.active]!)
    .update(
      JSON.stringify([
        "action-worker-status-v2",
        keys.active,
        Number(attempt),
        statusMessage(signedStatus),
      ])
    )
    .digest("base64url");
  return `${description} [${prefix}${digest}]`;
}

export function hasValidStatusAttestation(
  value: unknown,
  subject: { repository: string; sha: string; context: string }
): boolean {
  if (!repositoryPattern.test(subject.repository) || !shaPattern.test(subject.sha)) {
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
  if (!match?.[3]) return hasMigrationReceipt(status, subject);
  const signedDescription = description.slice(0, match.index).trimEnd();
  const statusInput: CommitStatus = {
    repository: subject.repository,
    sha: subject.sha,
    context: subject.context,
    state: state as CommitStatus["state"],
    description: signedDescription,
    targetUrl,
  };
  const keys = parseStatusSigningKeys(process.env.AW_STATUS_KEYRING ?? "");
  const keyId = match[1];
  const actual = Buffer.from(match[3], "base64url");
  if (keyId) {
    const key = keys?.keys[keyId];
    if (!key) return false;
    const expected = createHmac("sha256", key)
      .update(
        JSON.stringify([
          "action-worker-status-v2",
          keyId,
          Number(match[2]),
          statusMessage(statusInput),
        ])
      )
      .digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  return (keys?.legacy_tokens ?? []).some((key) => {
    const expected = createHmac("sha256", key).update(statusMessage(statusInput)).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** Read only after validating the attestation: the attempt is part of the signed message. */
export function statusRunAttempt(value: unknown): number | null {
  const match = signaturePattern.exec(getJsonString(value, "description"));
  return match?.[1] && match[2] ? Number(match[2]) : null;
}

export function latestAttestedStatus(
  response: unknown,
  subject: { repository: string; sha: string; context: string }
): JsonRecord | undefined {
  const latest = getJsonArray(response, "statuses")
    .filter(isJsonRecord)
    .filter((status) => getJsonString(status, "context") === subject.context)
    .sort((left, right) =>
      getJsonString(right, "created_at").localeCompare(getJsonString(left, "created_at"))
    )[0];
  return latest && hasValidStatusAttestation(latest, subject) ? latest : undefined;
}
