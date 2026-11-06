import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  privateKeyFingerprint,
  publicKeyFingerprint,
  validateTaskTransferKeyRole,
} from "../scripts/validate-task-transfer-key-role.ts";

function pair(bits = 3072) {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return {
    publicKey: keys.publicKey.toString("base64"),
    privateKey: keys.privateKey,
  };
}

test("approved fingerprints permit independent trusted and task runner key roles", () => {
  const inbound = pair();
  const outbound = pair();
  const expected = {
    AW_TASK_TRANSFER_EXPECTED_INBOUND_FINGERPRINT: publicKeyFingerprint(inbound.publicKey),
    AW_TASK_TRANSFER_EXPECTED_OUTBOUND_FINGERPRINT: publicKeyFingerprint(outbound.publicKey),
  };
  assert.equal(
    privateKeyFingerprint(inbound.privateKey),
    expected.AW_TASK_TRANSFER_EXPECTED_INBOUND_FINGERPRINT
  );
  assert.deepEqual(
    validateTaskTransferKeyRole("trusted-prepare", {
      ...expected,
      AW_ARTIFACT_KEY: "trusted-only-key",
      AW_TASK_TRANSFER_INBOUND_PUBLIC_KEY: inbound.publicKey,
    }),
    { verified: true, role: "trusted-prepare" }
  );
  assert.deepEqual(
    validateTaskTransferKeyRole("task", {
      ...expected,
      AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY: inbound.privateKey,
      AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY: outbound.publicKey,
    }),
    { verified: true, role: "task" }
  );
  assert.deepEqual(
    validateTaskTransferKeyRole("trusted-finalize", {
      ...expected,
      AW_ARTIFACT_KEY: "trusted-only-key",
      AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY: outbound.privateKey,
    }),
    { verified: true, role: "trusted-finalize" }
  );
});

test("weak RSA, invalid encoding and wrong key pairs fail closed", () => {
  const inbound = pair();
  const outbound = pair();
  const wrong = pair();
  const weak = pair(2048);
  const expected = {
    AW_TASK_TRANSFER_EXPECTED_INBOUND_FINGERPRINT: publicKeyFingerprint(inbound.publicKey),
    AW_TASK_TRANSFER_EXPECTED_OUTBOUND_FINGERPRINT: publicKeyFingerprint(outbound.publicKey),
  };
  assert.throws(() => publicKeyFingerprint(weak.publicKey), /contract failed/);
  assert.throws(() => privateKeyFingerprint(weak.privateKey), /contract failed/);
  assert.throws(() => publicKeyFingerprint("!!!"), /contract failed/);
  assert.throws(() => privateKeyFingerprint("wrong"), /contract failed/);
  assert.throws(
    () =>
      validateTaskTransferKeyRole("task", {
        ...expected,
        AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY: wrong.privateKey,
        AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY: outbound.publicKey,
      }),
    /contract failed/
  );
  assert.throws(
    () =>
      validateTaskTransferKeyRole("trusted-finalize", {
        ...expected,
        AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY: inbound.privateKey,
      }),
    /contract failed/
  );
});

test("central key leakage, role mixing and same-key reuse fail closed", () => {
  const inbound = pair();
  const outbound = pair();
  const expected = {
    AW_TASK_TRANSFER_EXPECTED_INBOUND_FINGERPRINT: publicKeyFingerprint(inbound.publicKey),
    AW_TASK_TRANSFER_EXPECTED_OUTBOUND_FINGERPRINT: publicKeyFingerprint(outbound.publicKey),
  };
  for (const forbidden of [
    "AW_ARTIFACT_KEY",
    "AW_ADMIN_TOKEN",
    "AW_APP_PRIVATE_KEY",
    "AW_STATUS_KEYRING",
    "AW_PUBLICATION_PRIVATE_KEY",
  ]) {
    assert.throws(
      () =>
        validateTaskTransferKeyRole("task", {
          ...expected,
          AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY: inbound.privateKey,
          AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY: outbound.publicKey,
          [forbidden]: "leaked",
        }),
      /contract failed/
    );
  }
  assert.throws(
    () =>
      validateTaskTransferKeyRole("task", {
        ...expected,
        AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY: inbound.privateKey,
        AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY: outbound.publicKey,
        AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY: outbound.privateKey,
      }),
    /contract failed/
  );
  assert.throws(
    () =>
      validateTaskTransferKeyRole("trusted-prepare", {
        ...expected,
        AW_TASK_TRANSFER_INBOUND_PUBLIC_KEY: inbound.publicKey,
        AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY: inbound.privateKey,
      }),
    /contract failed/
  );
  assert.throws(
    () =>
      validateTaskTransferKeyRole("task", {
        ...expected,
        AW_TASK_TRANSFER_EXPECTED_OUTBOUND_FINGERPRINT:
          expected.AW_TASK_TRANSFER_EXPECTED_INBOUND_FINGERPRINT,
        AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY: inbound.privateKey,
        AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY: inbound.publicKey,
      }),
    /contract failed/
  );
});

test("fingerprints require independent trusted pinning, never blank or malformed values", () => {
  const inbound = pair();
  const outbound = pair();
  assert.throws(
    () =>
      validateTaskTransferKeyRole("trusted-prepare", {
        AW_TASK_TRANSFER_INBOUND_PUBLIC_KEY: inbound.publicKey,
        AW_TASK_TRANSFER_EXPECTED_INBOUND_FINGERPRINT: "0000",
        AW_TASK_TRANSFER_EXPECTED_OUTBOUND_FINGERPRINT: publicKeyFingerprint(outbound.publicKey),
      }),
    /contract failed/
  );
  assert.throws(() => validateTaskTransferKeyRole("task", {}), /contract failed/);
});
