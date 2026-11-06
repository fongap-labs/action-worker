import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTaskTransferCommand } from "../scripts/task-transfer-job.ts";

const ref = "a".repeat(40);
const repository = "fongap-labs/test-product";

function keypair() {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return {
    publicKey: keys.publicKey.toString("base64"),
    privateKey: keys.privateKey,
  };
}

function env() {
  return {
    TASK_SOURCE_REPOSITORY: repository,
    PROJECT: "product",
    BOOTSTRAP_REF: ref,
    REQUEST_ID: "request-1",
    GITHUB_RUN_ID: "4000000000",
    GITHUB_RUN_ATTEMPT: "1",
  };
}

test("task state is transferred using inbound and outbound keys without governance secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-task-job-"));
  try {
    const inbound = keypair();
    const outbound = keypair();
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({
        repository,
        project: "product",
        bootstrap_ref: ref,
      })
    );
    await writeFile(join(source, "cursor.txt"), "42");
    const incoming = join(root, "incoming.seal");
    await runTaskTransferCommand("seal-state", "state-to-task", source, incoming, {
      ...env(),
      AW_TASK_TRANSFER_ROLE: "trusted-prepare",
      AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: inbound.publicKey,
    });
    const taskState = join(root, "task-state");
    await runTaskTransferCommand("open-state", "state-to-task", incoming, taskState, {
      ...env(),
      AW_TASK_TRANSFER_ROLE: "task",
      AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: inbound.privateKey,
    });
    assert.equal(await readFile(join(taskState, "cursor.txt"), "utf8"), "42");
    const encrypted = join(root, "outgoing.seal");
    await runTaskTransferCommand("seal-state", "state-from-task", taskState, encrypted, {
      ...env(),
      AW_TASK_TRANSFER_ROLE: "task",
      AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: outbound.publicKey,
    });
    await assert.rejects(
      runTaskTransferCommand("open-state", "state-from-task", encrypted, join(root, "wrong"), {
        ...env(),
        AW_TASK_TRANSFER_ROLE: "trusted-finalize",
        AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: inbound.privateKey,
      }),
      /decryption/
    );
    const destination = join(root, "trusted");
    await runTaskTransferCommand("open-state", "state-from-task", encrypted, destination, {
      ...env(),
      AW_TASK_TRANSFER_ROLE: "trusted-finalize",
      AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: outbound.privateKey,
    });
    assert.equal(await readFile(join(destination, "cursor.txt"), "utf8"), "42");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task log encryption binds run identity and never emits plaintext in the envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-task-job-"));
  try {
    const outbound = keypair();
    const logFile = join(root, "private.log");
    await writeFile(logFile, "private task log");
    const sealed = join(root, "private.seal");
    await runTaskTransferCommand("seal-log", "log-from-task", logFile, sealed, {
      ...env(),
      AW_TASK_TRANSFER_ROLE: "task",
      AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: outbound.publicKey,
    });
    assert.doesNotMatch((await readFile(sealed)).toString(), /private task log/);
    await assert.rejects(
      runTaskTransferCommand("open-log", "log-from-task", sealed, join(root, "invalid.log"), {
        ...env(),
        GITHUB_RUN_ATTEMPT: "2",
        AW_TASK_TRANSFER_ROLE: "trusted-finalize",
        AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: outbound.privateKey,
      }),
      /authentication/
    );
    const output = join(root, "opened.log");
    await runTaskTransferCommand("open-log", "log-from-task", sealed, output, {
      ...env(),
      AW_TASK_TRANSFER_ROLE: "trusted-finalize",
      AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: outbound.privateKey,
    });
    assert.equal(await readFile(output, "utf8"), "private task log");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("central credentials are rejected if available in a task process", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-task-job-"));
  try {
    await assert.rejects(
      runTaskTransferCommand("open-state", "state-to-task", "input", "output", {
        ...env(),
        AW_TASK_TRANSFER_ROLE: "task",
        AW_ARTIFACT_KEY: "configured",
      }),
      /forbidden credential role/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed open cannot remove a preexisting destination directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-task-job-"));
  try {
    const key = keypair();
    const destination = join(root, "preexisting");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "must survive");
    const state = join(root, "state");
    await mkdir(state);
    await writeFile(
      join(state, "manifest.json"),
      JSON.stringify({ repository, project: "product", bootstrap_ref: ref })
    );
    const sealed = join(root, "state.seal");
    await runTaskTransferCommand("seal-state", "state-from-task", state, sealed, {
      ...env(),
      AW_TASK_TRANSFER_ROLE: "task",
      AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: key.publicKey,
    });
    await assert.rejects(
      runTaskTransferCommand("open-state", "state-from-task", sealed, destination, {
        ...env(),
        AW_TASK_TRANSFER_ROLE: "trusted-finalize",
        AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: key.privateKey,
      }),
      /state validation/
    );
    assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transfer role is mandatory even when the encryption key is valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-task-job-"));
  try {
    const key = keypair();
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({ repository, project: "product", bootstrap_ref: ref })
    );
    for (const role of ["", "task", "trusted-finalize"]) {
      await assert.rejects(
        runTaskTransferCommand("seal-state", "state-to-task", source, join(root, "out.seal"), {
          ...env(),
          AW_TASK_TRANSFER_ROLE: role,
          AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: key.publicKey,
        }),
        /phase does not match/
      );
    }
    await assert.rejects(
      runTaskTransferCommand("open-state", "state-from-task", "incoming", "outgoing", {
        ...env(),
        AW_TASK_TRANSFER_ROLE: "task",
        AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: key.privateKey,
      }),
      /phase does not match/
    );
    await assert.rejects(
      runTaskTransferCommand("seal-state", "state-to-task", source, join(root, "out.seal"), {
        ...env(),
        AW_TASK_TRANSFER_ROLE: "trusted-prepare",
        AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY: key.privateKey,
        AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: key.publicKey,
      }),
      /forbidden credential role/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
