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
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const maxFileBytes = 50 * 1024 * 1024;
const maxTotalBytes = 100 * 1024 * 1024;
const maxSealedBytes = 150 * 1024 * 1024;
const maxFiles = 2000;

type PublicationFile = { path: string; base64: string };
type Payload = { manifest: unknown; files: PublicationFile[] };

type Envelope = {
  schema_version: "1";
  encrypted_key: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export type PublicationIdentity = {
  repository: string;
  project: string;
  bootstrap_ref: string;
};

function aad(identity: PublicationIdentity): Buffer {
  return Buffer.from(JSON.stringify({ schema_version: "1", ...identity }));
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\0\r\n]/.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

async function collect(root: string, current = root): Promise<PublicationFile[]> {
  const found: PublicationFile[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const stats = await lstat(full);
    if (stats.isSymbolicLink()) {
      throw new CliError("Publication payload must not contain symbolic links.", 66);
    }
    if (stats.isDirectory()) {
      found.push(...(await collect(root, full)));
      continue;
    }
    const name = relative(root, full).split(sep).join("/");
    if (!stats.isFile() || !validPath(name) || stats.size > maxFileBytes) {
      throw new CliError("Publication payload contains an invalid file.", 66);
    }
    found.push({ path: name, base64: (await readFile(full)).toString("base64") });
    if (found.length > maxFiles) {
      throw new CliError("Publication payload exceeds file count limit.", 66);
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function keyPublic(raw: string) {
  const key = createPublicKey({
    key: Buffer.from(raw.trim(), "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new CliError("Publication encryption key must be RSA 3072-bit or stronger.", 77);
  }
  return key;
}

function keyPrivate(raw: string) {
  const key = createPrivateKey(raw);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new CliError("Publication decryption key must be RSA 3072-bit or stronger.", 77);
  }
  return key;
}

export async function sealTaskPublication(
  root: string,
  identity: PublicationIdentity,
  publicKey: string
): Promise<Buffer> {
  if (!identity.repository || !identity.project || !/^[0-9a-f]{40}$/.test(identity.bootstrap_ref)) {
    throw new CliError("Publication source identity must be complete and pinned.", 64);
  }
  const manifestPath = join(root, "manifest.json");
  const payloadRoot = join(root, "payload");
  const manifestInfo = await lstat(manifestPath);
  const payloadInfo = await lstat(payloadRoot);
  if (!manifestInfo.isFile() || !payloadInfo.isDirectory() || payloadInfo.isSymbolicLink()) {
    throw new CliError("Publication directory is invalid.", 66);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const files = await collect(payloadRoot);
  if (!files.length || files.length > maxFiles) {
    throw new CliError("Publication payload must contain between 1 and 2000 files.", 66);
  }
  const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.base64, "base64"), 0);
  if (total > maxTotalBytes) {
    throw new CliError("Publication exceeds the sealed transfer size limit.", 66);
  }

  const encryptionKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad(identity));
  const compressed = gzipSync(Buffer.from(JSON.stringify({ manifest, files } satisfies Payload)));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const wrapped = publicEncrypt(
    { key: keyPublic(publicKey), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    encryptionKey
  );
  const envelope: Envelope = {
    schema_version: "1",
    encrypted_key: wrapped.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope));
}

export async function openTaskPublication(
  input: Buffer,
  identity: PublicationIdentity,
  privateKey: string,
  output: string
): Promise<void> {
  if (input.length > maxSealedBytes) {
    throw new CliError("Sealed publication exceeds the transfer limit.", 66);
  }
  const envelope: unknown = JSON.parse(input.toString("utf8"));
  if (
    !isJsonRecord(envelope) ||
    envelope.schema_version !== "1" ||
    !["encrypted_key", "iv", "tag", "ciphertext"].every(
      (field) => typeof envelope[field] === "string"
    )
  ) {
    throw new CliError("Sealed publication identity does not match the verified task.", 66);
  }
  const decryptedKey = privateDecrypt(
    { key: keyPrivate(privateKey), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(envelope.encrypted_key as string, "base64")
  );
  if (decryptedKey.length !== 32) throw new CliError("Invalid publication encryption key.", 66);
  const iv = Buffer.from(envelope.iv as string, "base64");
  const tag = Buffer.from(envelope.tag as string, "base64");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new CliError("Invalid sealed publication encryption header.", 66);
  }
  const decipher = createDecipheriv("aes-256-gcm", decryptedKey, iv);
  decipher.setAAD(aad(identity));
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext as string, "base64")),
    decipher.final(),
  ]);
  const raw = gunzipSync(compressed, { maxOutputLength: maxTotalBytes * 2 });
  const payload: unknown = JSON.parse(raw.toString("utf8"));
  if (!isJsonRecord(payload) || !Array.isArray(payload.files) || payload.files.length > maxFiles) {
    throw new CliError("Sealed publication payload structure is invalid.", 66);
  }
  if (typeof payload.manifest !== "object" || payload.manifest === null) {
    throw new CliError("Sealed publication manifest is invalid.", 66);
  }
  const files = payload.files;
  if (!files.length) throw new CliError("Sealed publication payload is empty.", 66);
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (
      !isJsonRecord(file) ||
      typeof file.path !== "string" ||
      typeof file.base64 !== "string" ||
      !validPath(file.path) ||
      seen.has(file.path)
    ) {
      throw new CliError("Sealed publication contains an unsafe or duplicate path.", 66);
    }
    seen.add(file.path);
    const data = Buffer.from(file.base64, "base64");
    total += data.length;
    if (data.length > maxFileBytes || total > maxTotalBytes) {
      throw new CliError("Sealed publication payload exceeds the size limit.", 66);
    }
  }
  await mkdir(join(output, "payload"), { recursive: true });
  await writeFile(join(output, "manifest.json"), JSON.stringify(payload.manifest));
  for (const file of files) {
    const entry = file as PublicationFile;
    const destination = join(output, "payload", entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(entry.base64, "base64"), { flag: "wx" });
  }
}

async function main(): Promise<void> {
  const [operation = "", first = "", second = ""] = process.argv.slice(2);
  const identity: PublicationIdentity = {
    repository: process.env.TASK_SOURCE_REPOSITORY ?? "",
    project: process.env.PROJECT ?? "",
    bootstrap_ref: process.env.BOOTSTRAP_REF ?? "",
  };
  if (!first || !second)
    throw new CliError("Usage: task-publication-envelope.ts seal|open IN OUT", 64);
  if (operation === "seal") {
    const publicKey = process.env.AW_PUBLICATION_PUBLIC_KEY ?? "";
    if (!publicKey)
      throw new CliError("AW_PUBLICATION_PUBLIC_KEY repository variable is required.", 77);
    const data = await sealTaskPublication(first, identity, publicKey);
    await mkdir(dirname(second), { recursive: true });
    await writeFile(second, data, { flag: "wx" });
  } else if (operation === "open") {
    const privateKey = process.env.AW_PUBLICATION_PRIVATE_KEY ?? "";
    if (!privateKey) throw new CliError("AW_PUBLICATION_PRIVATE_KEY is required.", 77);
    await openTaskPublication(await readFile(first), identity, privateKey, second);
  } else {
    throw new CliError("Usage: task-publication-envelope.ts seal|open IN OUT", 64);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
