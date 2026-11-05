import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openTaskTransfer, sealTaskTransfer } from "../scripts/task-transfer-envelope.ts";
import {
  packTaskTransferFiles,
  unpackTaskTransferFiles,
  validateTaskTransferFiles,
} from "../scripts/task-transfer-files.ts";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "aw-task-file-test-"));
  const source = join(root, "source");
  await mkdir(source);
  return { root, source };
}

function payload(entries: unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ schema_version: "1", entries }));
}

test("task transfer preserves file content through authenticated encrypted runner handoff", async () => {
  const { root, source } = await sandbox();
  try {
    await mkdir(join(source, "nested"));
    await mkdir(join(source, "empty"));
    await writeFile(join(source, "nested", "state.json"), JSON.stringify({ count: 3 }));
    const plain = await packTaskTransferFiles(source);
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { format: "der", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    const identity = {
      repository: "fongap-labs/example",
      project: "sample",
      bootstrap_ref: "a".repeat(40),
      request_id: "req-1",
      run_id: "42000001",
      run_attempt: "1",
      purpose: "state-from-task" as const,
    };
    const sealed = sealTaskTransfer(plain, identity, keys.publicKey.toString("base64"));
    assert.doesNotMatch(sealed.toString("utf8"), /state.json|nested|count/);
    const opened = openTaskTransfer(sealed, identity, keys.privateKey);
    const dest = join(root, "restored");
    await unpackTaskTransferFiles(opened, dest);
    assert.equal(await readFile(join(dest, "nested", "state.json"), "utf8"), '{"count":3}');
    assert.equal((await lstat(join(dest, "nested", "state.json"))).mode & 0o777, 0o600);
    assert.ok((await lstat(join(dest, "empty"))).isDirectory());
    await assert.rejects(unpackTaskTransferFiles(opened, dest), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task transfer refuses symbolic links, hard links and device-like files", async () => {
  const { root, source } = await sandbox();
  try {
    const sourceFile = join(source, "real.txt");
    await writeFile(sourceFile, "data");
    await link(sourceFile, join(source, "hard.txt"));
    await assert.rejects(packTaskTransferFiles(source), /unsafe or oversized/);
    await rm(join(source, "hard.txt"));
    await symlink(sourceFile, join(source, "symlink.txt"));
    await assert.rejects(packTaskTransferFiles(source), /symbolic links/);
    await rm(join(source, "symlink.txt"));
    execFileSync("mkfifo", [join(source, "pipe")]);
    await assert.rejects(packTaskTransferFiles(source), /unsafe or oversized/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task transfer refuses traversal, untrusted metadata and path collisions", () => {
  const file = { kind: "file", path: "a.txt", base64: Buffer.from("data").toString("base64") };
  for (const unsafe of ["../escape", "/abs", "folder/../escape", ".git/hooks", "a//b", "x\\y"]) {
    assert.throws(
      () => validateTaskTransferFiles(payload([{ ...file, path: unsafe }])),
      /unsafe path/
    );
  }
  assert.throws(
    () => validateTaskTransferFiles(payload([file, { ...file, path: "A.txt" }])),
    /duplicated/
  );
  assert.throws(
    () => validateTaskTransferFiles(payload([{ ...file, path: "parent/child" }])),
    /parent directory/
  );
  assert.throws(
    () =>
      validateTaskTransferFiles(
        payload([
          { kind: "directory", path: "parent" },
          { ...file, path: "parent/child", unexpected: true },
        ])
      ),
    /schema/
  );
  assert.throws(() => validateTaskTransferFiles(payload([{ ...file, base64: "??" }])), /encoding/);
});

test("task transfer rejects large state files and malformed payloads before write", async () => {
  const { root, source } = await sandbox();
  try {
    await writeFile(join(source, "too-big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(packTaskTransferFiles(source), /unsafe or oversized/);
    const destination = join(root, "should-not-exist");
    await assert.rejects(
      unpackTaskTransferFiles(Buffer.from('{"entries":[]}'), destination),
      /schema/
    );
    await assert.rejects(lstat(destination), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
