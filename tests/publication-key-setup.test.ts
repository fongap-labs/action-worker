import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  generatePublicationKeys,
  validatePublicationKeyPair,
  verifyPublicationKeys,
} from "../scripts/prepare-publication-keys.ts";
import { CliError } from "../scripts/runtime-command.ts";

test("publication setup generates compatible RSA-3072 keys outside the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-publication-key-test-"));
  try {
    const { publicPath, privatePath } = await generatePublicationKeys(join(root, "keys"));
    const publicText = await readFile(publicPath, "utf8");
    const privateText = await readFile(privatePath, "utf8");
    assert.match(publicText.trim(), /^[A-Za-z0-9+/]+=*$/);
    assert.match(privateText, new RegExp(["^-----BEGIN", "PRIVATE KEY-----"].join(" ")));
    assert.doesNotMatch(publicText, /BEGIN PRIVATE KEY/);
    validatePublicationKeyPair(publicText, privateText);
    await verifyPublicationKeys(publicPath, privatePath);
    if (process.platform !== "win32") {
      assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
      assert.equal((await stat(publicPath)).mode & 0o777, 0o600);
    }
    await assert.rejects(generatePublicationKeys(join(root, "keys")), { code: "EEXIST" });
    assert.equal(await readFile(privatePath, "utf8"), privateText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication setup rejects unrelated and weak private keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-publication-key-mismatch-"));
  try {
    const first = await generatePublicationKeys(join(root, "first"));
    const second = await generatePublicationKeys(join(root, "second"));
    await assert.rejects(
      verifyPublicationKeys(first.publicPath, second.privatePath),
      /do not form a pair/
    );
    const weak = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    assert.throws(
      () => validatePublicationKeyPair(weak.publicKey.toString("base64"), weak.privateKey),
      /at least 3072 bits/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication setup refuses key files inside the repository without writing", async () => {
  await assert.rejects(
    generatePublicationKeys(join(process.cwd(), ".temp-publication-keys-should-not-exist")),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === 77 &&
      error.message.includes("outside the source checkout")
  );
});
