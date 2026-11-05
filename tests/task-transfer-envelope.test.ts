import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  openTaskTransfer,
  sealTaskTransfer,
  type TransferIdentity,
} from "../scripts/task-transfer-envelope.ts";

const identity: TransferIdentity = {
  repository: "fongap-labs/private-source",
  project: "sample",
  bootstrap_ref: "a".repeat(40),
  request_id: "request-123",
  run_id: "420123456",
  run_attempt: "1",
  purpose: "state-from-task",
};

function keypair(bits = 3072): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return {
    publicKey: pair.publicKey.toString("base64"),
    privateKey: pair.privateKey,
  };
}

test("task transfer encrypts data without exposing private source or task output", () => {
  const pair = keypair();
  const plain = Buffer.from("a private task output not intended for public artifacts");
  const encrypted = sealTaskTransfer(plain, identity, pair.publicKey);
  assert.doesNotMatch(encrypted.toString("utf8"), /private-source|private task output|sample/);
  assert.deepEqual(openTaskTransfer(encrypted, identity, pair.privateKey), plain);
});

test("task transfer rejects cross-project, run and purpose replay", () => {
  const pair = keypair();
  const encrypted = sealTaskTransfer(Buffer.from("private state"), identity, pair.publicKey);
  const wrong: TransferIdentity[] = [
    { ...identity, project: "other" },
    { ...identity, repository: "fongap-labs/other" },
    { ...identity, bootstrap_ref: "b".repeat(40) },
    { ...identity, request_id: "request-124" },
    { ...identity, run_id: "420123457" },
    { ...identity, run_attempt: "2" },
    { ...identity, purpose: "state-to-task" },
    { ...identity, purpose: "log-from-task" },
  ];
  for (const other of wrong) {
    assert.throws(() => openTaskTransfer(encrypted, other, pair.privateKey), /authentication/);
  }
});

test("task transfer rejects malformed, duplicate-key equivalent and tampered envelopes", () => {
  const pair = keypair();
  const encrypted = sealTaskTransfer(Buffer.from("payload"), identity, pair.publicKey);
  const parsed = JSON.parse(encrypted.toString("utf8")) as Record<string, string>;
  assert.throws(() => openTaskTransfer(Buffer.from("not-json"), identity, pair.privateKey));
  assert.throws(() => openTaskTransfer(Buffer.from("{}"), identity, pair.privateKey));
  assert.throws(
    () => openTaskTransfer(Buffer.from(JSON.stringify({ ...parsed, unauthorized: true })), identity, pair.privateKey),
    /schema/
  );
  assert.throws(
    () => openTaskTransfer(Buffer.from(JSON.stringify({ ...parsed, nonce: "***" })), identity, pair.privateKey),
    /encoding/
  );
  assert.throws(
    () => openTaskTransfer(Buffer.from(JSON.stringify({ ...parsed, tag: Buffer.alloc(16).toString("base64") })), identity, pair.privateKey),
    /authentication/
  );
  const other = keypair();
  assert.throws(() => openTaskTransfer(encrypted, identity, other.privateKey), /authentication/);
});

test("task transfer refuses weak RSA keys and oversized input", () => {
  const weak = keypair(2048);
  assert.throws(
    () => sealTaskTransfer(Buffer.from("payload"), identity, weak.publicKey),
    /RSA-3072/
  );
  const good = keypair();
  assert.throws(
    () => sealTaskTransfer(Buffer.alloc(16 * 1024 * 1024 + 1), identity, good.publicKey),
    /size limit/
  );
  assert.throws(
    () => openTaskTransfer(Buffer.alloc(24 * 1024 * 1024 + 1), identity, good.privateKey),
    /size limit/
  );
});

test("task transfer rejects malformed context before encryption", () => {
  const pair = keypair();
  assert.throws(
    () => sealTaskTransfer(Buffer.from("data"), { ...identity, run_id: "0" }, pair.publicKey),
    /identity/
  );
  assert.throws(
    () => sealTaskTransfer(Buffer.from("data"), { ...identity, project: "../other" }, pair.publicKey),
    /identity/
  );
});
