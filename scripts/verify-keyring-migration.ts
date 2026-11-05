import { timingSafeEqual } from "node:crypto";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { parseStatusSigningKeys, type StatusSigningKeys } from "./status-signing-keys.ts";

function canonical(value: StatusSigningKeys): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: value.schema_version,
      active: value.active,
      keys: Object.entries(value.keys).sort(([a], [b]) => a.localeCompare(b)),
      legacy_tokens: [...value.legacy_tokens].sort(),
    })
  );
}

export function keyringsMatch(oldRaw: string, newRaw: string): boolean {
  const original = parseStatusSigningKeys(oldRaw);
  const replacement = parseStatusSigningKeys(newRaw);
  if (!original || !replacement) return false;
  const oldBytes = canonical(original);
  const newBytes = canonical(replacement);
  return oldBytes.length === newBytes.length && timingSafeEqual(oldBytes, newBytes);
}

function main(): void {
  if (!process.env.AW_STATUS_SIGNING_KEYS || !process.env.AW_STATUS_KEYRING) {
    throw new CliError("Both existing and replacement signing keyrings must be configured.", 77);
  }
  if (!keyringsMatch(process.env.AW_STATUS_SIGNING_KEYS, process.env.AW_STATUS_KEYRING)) {
    throw new CliError(
      "Signing keyring migration failed: active key, historical keys, or legacy verifiers differ. No key was changed.",
      77
    );
  }
  console.log("Signing keyring migration preflight passed. Existing key material is unchanged.");
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    handleError(error);
  }
}
