import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeTrustedTaskArtifacts } from "../scripts/finalize-trusted-task-artifacts.ts";
import {
  openBytes,
  openStateFile,
  sealedLogFile,
  sealedStateFile,
  writeTaskStateManifest,
} from "../scripts/task-state.ts";
import { runTaskTransferCommand } from "../scripts/task-transfer-job.ts";

const repository = "fongap-labs/product";
const project = "demo";
const ref = "a".repeat(40);
const originalKey = Buffer.alloc(32, 7);

function pair() {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return { publicKey: keys.publicKey.toString("base64"), privateKey: keys.privateKey };
}

function transferEnv(publicKey: string) {
  return {
    TASK_SOURCE_REPOSITORY: repository,
    PROJECT: project,
    BOOTSTRAP_REF: ref,
    REQUEST_ID: "req-1",
    GITHUB_RUN_ID: "42000001",
    GITHUB_RUN_ATTEMPT: "1",
    AW_TASK_TRANSFER_ROLE: "task",
    AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: publicKey,
  };
}

function finalizeSettings(
  root: string,
  privateKey: string,
  encryptedState: string | null,
  encryptedLog: string | null,
  isPrivate = true
) {
  return {
    repository,
    project,
    bootstrapRef: ref,
    requestId: "req-1",
    runId: "42000001",
    runAttempt: "1",
    isPrivate,
    artifactKey: isPrivate ? originalKey : null,
    outboundPrivateKey: privateKey,
    encryptedStatePath: encryptedState,
    encryptedLogPath: encryptedLog,
    workRoot: join(root, "trusted"),
  };
}

test("trusted runner reseals private task state in the historical AWSEAL1 format", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-finalize-state-"));
  try {
    const key = pair();
    const source = join(root, "output");
    await writeTaskStateManifest(source, repository, project, ref);
    await writeFile(join(source, "cursor.txt"), "24");
    const encrypted = join(root, "outbound.seal");
    await runTaskTransferCommand(
      "seal-state",
      "state-from-task",
      source,
      encrypted,
      transferEnv(key.publicKey)
    );
    const result = await finalizeTrustedTaskArtifacts(
      finalizeSettings(root, key.privateKey, encrypted, null)
    );
    assert.ok(result.stateUploadPath);
    const sealed = await readFile(join(result.stateUploadPath, sealedStateFile));
    assert.doesNotMatch(sealed.toString("utf8"), /cursor|fongap-labs|24/);
    const previous = join(root, "previous");
    await openStateFile(
      originalKey,
      join(result.stateUploadPath, sealedStateFile),
      repository,
      project,
      previous,
      true
    );
    assert.equal(await readFile(join(previous, "cursor.txt"), "utf8"), "24");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted runner reseals private task log without publishing plaintext", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-finalize-state-"));
  try {
    const key = pair();
    const logFile = join(root, "private.log");
    await writeFile(logFile, "secret task output");
    const encrypted = join(root, "private.seal");
    await runTaskTransferCommand(
      "seal-log",
      "log-from-task",
      logFile,
      encrypted,
      transferEnv(key.publicKey)
    );
    const result = await finalizeTrustedTaskArtifacts(
      finalizeSettings(root, key.privateKey, null, encrypted)
    );
    assert.equal(result.stateUploadPath, null);
    assert.ok(result.logUploadPath);
    const sealed = await readFile(join(result.logUploadPath, sealedLogFile));
    assert.doesNotMatch(sealed.toString("utf8"), /secret task output/);
    assert.equal(
      openBytes(originalKey, "task-log", repository, project, sealed).toString(),
      "secret task output"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public task state preserves the original plaintext public artifact format", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-finalize-state-"));
  try {
    const key = pair();
    const state = join(root, "public-source");
    await writeTaskStateManifest(state, repository, project, ref);
    await writeFile(join(state, "counter"), "10");
    const encrypted = join(root, "public.seal");
    await runTaskTransferCommand(
      "seal-state",
      "state-from-task",
      state,
      encrypted,
      transferEnv(key.publicKey)
    );
    const result = await finalizeTrustedTaskArtifacts(
      finalizeSettings(root, key.privateKey, encrypted, null, false)
    );
    assert.ok(result.stateUploadPath);
    assert.equal(await readFile(join(result.stateUploadPath, "counter"), "utf8"), "10");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bad run identity and missing original key are rejected before state output", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-finalize-state-"));
  try {
    const key = pair();
    const state = join(root, "source");
    await writeTaskStateManifest(state, repository, project, ref);
    const encrypted = join(root, "bad.seal");
    await runTaskTransferCommand(
      "seal-state",
      "state-from-task",
      state,
      encrypted,
      transferEnv(key.publicKey)
    );
    await assert.rejects(
      finalizeTrustedTaskArtifacts({
        ...finalizeSettings(root, key.privateKey, encrypted, null),
        runAttempt: "2",
      }),
      /authentication/
    );
    await assert.rejects(
      finalizeTrustedTaskArtifacts({
        ...finalizeSettings(root, key.privateKey, encrypted, null),
        artifactKey: null,
      }),
      /existing artifact key/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
