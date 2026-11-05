import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

// This primitive does not authorize any job, key distribution or artifact download.
// Callers must enforce the isolated runner contract before using it in production.
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 24 * 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type TransferPurpose = "state-to-task" | "state-from-task" | "log-from-task";

export type TransferIdentity = {
  repository: string;
  project: string;
  bootstrap_ref: string;
  request_id: string;
  run_id: string;
  run_attempt: string;
  purpose: TransferPurpose;
};

function validateIdentity(identity: TransferIdentity): void {
  if (
    !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(identity.repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(identity.project) ||
    !/^[a-f0-9]{40}$/.test(identity.bootstrap_ref) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(identity.request_id) ||
    !/^[1-9][0-9]{0,18}$/.test(identity.run_id) ||
    !/^[1-9][0-9]{0,5}$/.test(identity.run_attempt) ||
    !["state-to-task", "state-from-task", "log-from-task"].includes(identity.purpose)
  ) {
    throw new CliError("Task transfer identity is invalid.", 65);
  }
}

function authenticatedIdentity(identity: TransferIdentity): Buffer {
  validateIdentity(identity);
  return Buffer.from(
    JSON.stringify({
      domain: "action-worker-task-transfer-v1",
      repository: identity.repository,
      project: identity.project,
      bootstrap_ref: identity.bootstrap_ref,
      request_id: identity.request_id,
      run_id: identity.run_id,
      run_attempt: identity.run_attempt,
      purpose: identity.purpose,
    }),
    "utf8"
  );
}

function base64Bytes(value: unknown, maxBytes: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !BASE64.test(value)
  ) {
    throw new CliError("Task transfer envelope contains invalid encoding.", 66);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maxBytes || decoded.toString("base64") !== value) {
    throw new CliError("Task transfer envelope contains invalid encoding.", 66);
  }
  return decoded;
}

function encryptionKey(encoded: string) {
  const publicKey = createPublicKey({
    key: base64Bytes(encoded, 4096),
    format: "der",
    type: "spki",
  });
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  ) {
    throw new CliError("Task transfer requires an RSA-3072 or stronger public key.", 77);
  }
  return publicKey;
}

function decryptionKey(privateKeyPem: string) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new CliError("Task transfer requires an RSA-3072 or stronger private key.", 77);
  }
  return key;
}

export function sealTaskTransfer(
  plaintext: Buffer,
  identity: TransferIdentity,
  recipientPublicKey: string
): Buffer {
  if (!Buffer.isBuffer(plaintext) || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new CliError("Task transfer plaintext exceeds the size limit.", 66);
  }
  const aad = authenticatedIdentity(identity);
  const recipient = encryptionKey(recipientPublicKey);
  const contentKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = publicEncrypt(
    { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    contentKey
  );
  const envelope = Buffer.from(
    JSON.stringify({
      schema_version: "1",
      wrapped_key: wrappedKey.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    }),
    "utf8"
  );
  if (envelope.length > MAX_ENVELOPE_BYTES) {
    throw new CliError("Task transfer envelope exceeds the size limit.", 66);
  }
  return envelope;
}

export function openTaskTransfer(
  envelopeBytes: Buffer,
  expectedIdentity: TransferIdentity,
  recipientPrivateKey: string
): Buffer {
  const aad = authenticatedIdentity(expectedIdentity);
  if (
    !Buffer.isBuffer(envelopeBytes) ||
    envelopeBytes.length === 0 ||
    envelopeBytes.length > MAX_ENVELOPE_BYTES
  ) {
    throw new CliError("Task transfer envelope exceeds the size limit.", 66);
  }
  let input: unknown;
  try {
    input = JSON.parse(envelopeBytes.toString("utf8")) as unknown;
  } catch {
    throw new CliError("Task transfer envelope is invalid.", 66);
  }
  if (
    !isJsonRecord(input) ||
    input.schema_version !== "1" ||
    Object.keys(input).sort().join(",") !== "ciphertext,nonce,schema_version,tag,wrapped_key"
  ) {
    throw new CliError("Task transfer envelope has an unsupported schema.", 66);
  }
  const wrapped = base64Bytes(input.wrapped_key, 1024);
  const nonce = base64Bytes(input.nonce, 12);
  const tag = base64Bytes(input.tag, 16);
  const ciphertext = base64Bytes(input.ciphertext, MAX_PLAINTEXT_BYTES);
  if (nonce.length !== 12 || tag.length !== 16 || wrapped.length < 384) {
    throw new CliError("Task transfer envelope has an invalid header.", 66);
  }
  try {
    const dataKey = privateDecrypt(
      {
        key: decryptionKey(recipientPrivateKey),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      wrapped
    );
    if (dataKey.length !== 32) throw new Error("Invalid data key");
    const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plain.length > MAX_PLAINTEXT_BYTES) {
      throw new Error("Size limit exceeded");
    }
    return plain;
  } catch {
    throw new CliError("Task transfer failed authentication or decryption.", 66);
  }
}
