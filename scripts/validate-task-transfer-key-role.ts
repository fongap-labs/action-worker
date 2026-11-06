import {
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { CliError, handleError, isMain } from "./runtime-command.ts";

// Key fingerprints must come from independently approved central configuration.
// This gate cannot create a credential, approve an alias, or authorize a task.
type KeyRole = "trusted-prepare" | "task" | "trusted-finalize";
type Environment = Record<string, string | undefined>;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fail(): never {
  throw new CliError("Task transfer key role contract failed verification.", 77);
}

function publicDer(key: KeyObject): Buffer {
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  ) {
    fail();
  }
  return createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer;
}

export function publicKeyFingerprint(encoded: string): string {
  if (
    !encoded ||
    encoded.length > 5500 ||
    !BASE64.test(encoded)
  ) fail();
  const der = Buffer.from(encoded, "base64");
  if (der.length > 4096 || der.toString("base64") !== encoded) fail();
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
    ) fail();
    const canonical = key.export({ format: "der", type: "spki" }) as Buffer;
    if (!canonical.equals(der)) fail();
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return fail();
  }
}

export function privateKeyFingerprint(pem: string): string {
  if (!pem || pem.length > 10000) fail();
  try {
    const privateKey = createPrivateKey(pem);
    return createHash("sha256").update(publicDer(privateKey)).digest("hex");
  } catch {
    return fail();
  }
}

function requireFingerprint(actual: string, expected: string): void {
  if (!FINGERPRINT.test(expected)) fail();
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail();
}

function rejectPresent(env: Environment, keys: readonly string[]): void {
  for (const key of keys) {
    if (env[key]) fail();
  }
}

export function validateTaskTransferKeyRole(
  role: KeyRole,
  env: Environment
): { verified: true; role: KeyRole } {
  const incoming = env.AW_TASK_TRANSFER_EXPECTED_INBOUND_FINGERPRINT ?? "";
  const outgoing = env.AW_TASK_TRANSFER_EXPECTED_OUTBOUND_FINGERPRINT ?? "";
  if (!FINGERPRINT.test(incoming) || !FINGERPRINT.test(outgoing) || incoming === outgoing) {
    fail();
  }

  if (role === "trusted-prepare") {
    rejectPresent(env, [
      "AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY",
      "AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY",
    ]);
    requireFingerprint(
      publicKeyFingerprint(env.AW_TASK_TRANSFER_INBOUND_PUBLIC_KEY ?? ""),
      incoming
    );
  } else if (role === "task") {
    rejectPresent(env, [
      "AW_ARTIFACT_KEY",
      "AW_ADMIN_TOKEN",
      "AW_APP_PRIVATE_KEY",
      "AW_STATUS_KEYRING",
      "AW_PUBLICATION_PRIVATE_KEY",
      "AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY",
      "AW_TASK_TRANSFER_INBOUND_PUBLIC_KEY",
    ]);
    requireFingerprint(
      privateKeyFingerprint(env.AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY ?? ""),
      incoming
    );
    requireFingerprint(
      publicKeyFingerprint(env.AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY ?? ""),
      outgoing
    );
  } else if (role === "trusted-finalize") {
    rejectPresent(env, [
      "AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY",
      "AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY",
    ]);
    requireFingerprint(
      privateKeyFingerprint(env.AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY ?? ""),
      outgoing
    );
  } else {
    fail();
  }
  return { verified: true, role };
}

async function main(): Promise<void> {
  const [role] = process.argv.slice(2);
  if (role !== "trusted-prepare" && role !== "task" && role !== "trusted-finalize") fail();
  validateTaskTransferKeyRole(role, process.env);
  console.log("Task transfer key role contract verified.");
}

if (isMain(import.meta.url)) main().catch(handleError);
