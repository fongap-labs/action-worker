import { timingSafeEqual } from "node:crypto";
import { CliError, handleError, isMain, runText } from "./runtime-command.ts";
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
  let replacement: StatusSigningKeys | null;
  try {
    replacement = parseStatusSigningKeys(newRaw);
  } catch {
    return false;
  }
  if (!original || !replacement) return false;
  const oldBytes = canonical(original);
  const newBytes = canonical(replacement);
  return oldBytes.length === newBytes.length && timingSafeEqual(oldBytes, newBytes);
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const oldRaw = process.env.AW_STATUS_SIGNING_KEYS ?? "";
  const newRaw = process.env.AW_STATUS_KEYRING ?? "";
  const adminToken = process.env.GH_TOKEN ?? "";
  const readToken = process.env.AW_BOOTSTRAP_READ_TOKEN ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  if (!oldRaw || !newRaw || !adminToken || !readToken || !/^[1-9][0-9]*$/.test(runId)) {
    throw new CliError("Signing migration requires both secrets and protected admin and read credentials.", 77);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError("Signing migration requires an exact control repository.", 77);
  }
  if (keyringsMatch(oldRaw, newRaw)) {
    console.log("Signing keyring migration preflight passed. Existing key material is unchanged.");
    return;
  }

  // Never trust a malformed original as a source for migration, even when the replacement is bad.
  if (!parseStatusSigningKeys(oldRaw)) {
    throw new CliError("Existing signing keyring is missing or invalid.", 77);
  }
  const run = JSON.parse(
    await runText("gh", ["api", `repos/${repository}/actions/runs/${runId}`], {
      env: { ...process.env, GH_TOKEN: readToken },
      timeoutMs: 30_000,
    })
  ) as { created_at?: string };
  const queuedAt = Date.parse(run.created_at ?? "");
  if (!Number.isFinite(queuedAt)) {
    throw new CliError("Signing migration cannot establish the workflow queue time.", 75);
  }
  for (const name of ["AW_STATUS_SIGNING_KEYS", "AW_STATUS_KEYRING"]) {
    const metadata = JSON.parse(
      await runText("gh", ["api", `repos/${repository}/actions/secrets/${name}`], {
        env: { ...process.env, GH_TOKEN: adminToken },
        timeoutMs: 30_000,
      })
    ) as { name?: string; updated_at?: string };
    const updatedAt = Date.parse(metadata.updated_at ?? "");
    if (metadata.name !== name || !Number.isFinite(updatedAt) || updatedAt >= queuedAt) {
      throw new CliError("Signing migration secret changed after this run started; refusing to overwrite.", 75);
    }
  }
  // One-way migration of existing trusted HMAC material. Never print values or pass them on argv.
  await runText("gh", ["secret", "set", "AW_STATUS_KEYRING", "--repo", repository], {
    input: oldRaw,
    env: { ...process.env, GH_TOKEN: adminToken },
    timeoutMs: 30_000,
  });
  console.log("Replacement signing keyring securely synchronized from existing material. Queue a new run to verify its fresh snapshot.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
