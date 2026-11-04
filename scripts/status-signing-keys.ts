import { randomBytes } from "node:crypto";
import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

export type StatusSigningKeys = {
  schema_version: 1;
  active: string;
  keys: Record<string, string>;
  // Retained in the serialized v1 format for old in-flight workflows. These values are now
  // treated only as HMAC verification material and are never used for GitHub API access.
  legacy_tokens: string[];
};

export function parseStatusSigningKeys(raw: string): StatusSigningKeys | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CliError("Invalid AW_STATUS_SIGNING_KEYS JSON.", 65);
  }
  if (
    !isJsonRecord(value) ||
    value.schema_version !== 1 ||
    typeof value.active !== "string" ||
    !/^[A-Za-z0-9_-]{1,12}$/.test(value.active) ||
    !isJsonRecord(value.keys) ||
    typeof value.keys[value.active] !== "string" ||
    !Object.entries(value.keys).every(
      ([id, key]) =>
        /^[A-Za-z0-9_-]{1,12}$/.test(id) &&
        typeof key === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(key)
    ) ||
    !Array.isArray(value.legacy_tokens) ||
    !value.legacy_tokens.every((t) => typeof t === "string" && t.length > 0)
  )
    throw new CliError("Invalid AW_STATUS_SIGNING_KEYS keyring.", 65);
  return value as StatusSigningKeys;
}

export function prepareStatusSigningKeys(
  raw: string,
  desiredId = "k1",
  generate = () => randomBytes(32).toString("base64url"),
  legacyToken = ""
): { keys: StatusSigningKeys; changed: boolean } {
  if (!/^[A-Za-z0-9_-]{1,12}$/.test(desiredId))
    throw new CliError("Signing bootstrap requires a valid key ID.", 77);
  const existing = parseStatusSigningKeys(raw);
  const legacyTokens = [...(existing?.legacy_tokens ?? [])];
  if (legacyToken && !legacyTokens.includes(legacyToken)) legacyTokens.push(legacyToken);
  if (
    existing?.active === desiredId &&
    legacyTokens.length === existing.legacy_tokens.length
  )
    return { keys: existing, changed: false };
  if (existing?.active === desiredId) {
    const keys = { ...existing, legacy_tokens: legacyTokens };
    parseStatusSigningKeys(JSON.stringify(keys));
    return { keys, changed: true };
  }
  if (existing && Object.hasOwn(existing.keys, desiredId))
    throw new CliError("Refusing to reactivate an old signing key ID.", 65);
  const keys: StatusSigningKeys = {
    schema_version: 1,
    active: desiredId,
    keys: { ...existing?.keys, [desiredId]: generate() },
    legacy_tokens: legacyTokens,
  };
  parseStatusSigningKeys(JSON.stringify(keys));
  return { keys, changed: true };
}

export function signingSnapshotIsFresh(
  raw: string,
  metadata: unknown | null,
  runCreatedAt: string
): boolean {
  const queuedAt = Date.parse(runCreatedAt);
  if (!Number.isFinite(queuedAt))
    throw new CliError("Cannot establish signing bootstrap queue time.", 75);
  if (metadata === null) return raw === "";
  if (
    !isJsonRecord(metadata) ||
    metadata.name !== "AW_STATUS_SIGNING_KEYS" ||
    typeof metadata.updated_at !== "string" ||
    !Number.isFinite(Date.parse(metadata.updated_at))
  )
    throw new CliError("Invalid signing secret metadata.", 75);
  // Repository secret values are snapshotted when a run is queued. A later queued initializer
  // must never overwrite the key installed by the first run.
  return raw !== "" && Date.parse(metadata.updated_at) < queuedAt;
}
