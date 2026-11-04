import { createPrivateKey, createPublicKey, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const publicFilename = "publication-public.spki.base64";
const privateFilename = "publication-private.pkcs8.pem";

export function validatePublicationKeyPair(publicText: string, privateText: string): void {
  const encoded = publicText.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new CliError("Publication public key must be standard base64 DER/SPKI.", 65);
  }
  let publicKey;
  let privateKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(encoded, "base64"),
      format: "der",
      type: "spki",
    });
    privateKey = createPrivateKey(privateText);
  } catch {
    throw new CliError("Invalid RSA publication key encoding.", 65);
  }
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    privateKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  ) {
    throw new CliError("Publication keys must use RSA with modulus length at least 3072 bits.", 77);
  }
  const supplied = publicKey.export({ format: "der", type: "spki" });
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (supplied.length !== derived.length || !timingSafeEqual(supplied, derived)) {
    throw new CliError("Publication public and private keys do not form a pair.", 77);
  }
}

export async function generatePublicationKeys(directory: string): Promise<{
  publicPath: string;
  privatePath: string;
}> {
  const target = resolve(directory);
  const checkoutRoot = await realpath(process.cwd());
  if (target === checkoutRoot || target.startsWith(`${checkoutRoot}${sep}`)) {
    throw new CliError("Generate publication keys outside the source checkout.", 77);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const targetRoot = await realpath(target);
  const metadata = await lstat(target);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    targetRoot === checkoutRoot ||
    targetRoot.startsWith(`${checkoutRoot}${sep}`)
  ) {
    throw new CliError("Generate publication keys outside the source checkout and outside symlinks.", 77);
  }
  const publicPath = join(targetRoot, publicFilename);
  const privatePath = join(targetRoot, privateFilename);
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  const encodedPublic = `${keys.publicKey.toString("base64")}\n`;
  validatePublicationKeyPair(encodedPublic, keys.privateKey);

  // Exclusive writes prohibit accidentally replacing the live keypair.
  await writeFile(privatePath, keys.privateKey, { flag: "wx", mode: 0o600 });
  try {
    await writeFile(publicPath, encodedPublic, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(privatePath, { force: true });
    throw error;
  }
  return { publicPath, privatePath };
}

export async function verifyPublicationKeys(publicPath: string, privatePath: string): Promise<void> {
  const [publicKey, privateKey] = await Promise.all([
    readFile(publicPath, "utf8"),
    readFile(privatePath, "utf8"),
  ]);
  validatePublicationKeyPair(publicKey, privateKey);
}

async function main(): Promise<void> {
  const [command = "", first = "", second = ""] = process.argv.slice(2);
  if (command === "generate" && first && !second) {
    const keys = await generatePublicationKeys(first);
    console.log(`Keypair created outside the checkout. Public file: ${keys.publicPath}`);
    console.log(`Private file: ${keys.privatePath} (never commit, log or upload as an artifact)`);
    return;
  }
  if (command === "verify" && first && second) {
    await verifyPublicationKeys(first, second);
    console.log("Publication keypair verified. Private key material is never printed.");
    return;
  }
  throw new CliError(
    "Usage: node scripts/prepare-publication-keys.ts generate OUTPUT_DIRECTORY | verify PUBLIC_FILE PRIVATE_FILE",
    64
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
