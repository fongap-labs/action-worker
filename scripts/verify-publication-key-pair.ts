import {
  constants,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const failed = "::error::Publication RSA-3072 public and protected private keys are missing, invalid, or mismatched.";

export function verifyPublicationKeyPair(publicBase64: string, privatePem: string): void {
  const encoded = publicBase64.trim();
  if (!encoded || !privatePem || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new CliError(failed, 77);
  }
  try {
    const publicBytes = Buffer.from(encoded, "base64");
    if (publicBytes.toString("base64") !== encoded) throw new Error("invalid public key encoding");
    const publicKey = createPublicKey({ key: publicBytes, type: "spki", format: "der" });
    const privateKey = createPrivateKey(privatePem);
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      privateKey.asymmetricKeyType !== "rsa" ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
    ) {
      throw new Error("RSA modulus below 3072 bits");
    }
    const derivedPublic = createPublicKey(privateKey).export({
      type: "spki",
      format: "der",
    });
    if (
      !Buffer.isBuffer(derivedPublic) ||
      publicBytes.length !== derivedPublic.length ||
      !timingSafeEqual(publicBytes, derivedPublic)
    ) {
      throw new Error("public/private key mismatch");
    }
    const challenge = randomBytes(32);
    const wrapped = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      challenge
    );
    const unwrapped = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      wrapped
    );
    if (challenge.length !== unwrapped.length || !timingSafeEqual(challenge, unwrapped)) {
      throw new Error("RSA-OAEP roundtrip failed");
    }
  } catch {
    // Never print secret material, decoded key objects, or crypto stack traces.
    throw new CliError(failed, 77);
  }
}

if (isMain(import.meta.url)) {
  try {
    verifyPublicationKeyPair(
      process.env.AW_PUBLICATION_PUBLIC_KEY ?? "",
      process.env.AW_PUBLICATION_PRIVATE_KEY ?? ""
    );
    console.log("Protected publication RSA key pair verified (RSA-3072+, OAEP-SHA256).");
  } catch (error) {
    handleError(error);
  }
}
