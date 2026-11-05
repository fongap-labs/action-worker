import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareTrustedTaskState } from "../scripts/prepare-trusted-task-state.ts";
import { sealStateDirectory, sealedStateFile, writeTaskStateManifest } from "../scripts/task-state.ts";
import { openTaskTransfer } from "../scripts/task-transfer-envelope.ts";
import { unpackTaskTransferFiles } from "../scripts/task-transfer-files.ts";

const repository = "fongap-labs/example";
const project = "demo";
const bootstrapRef = "a".repeat(40);
const artifactSecret = Buffer.alloc(32, 7);

const trustedRun = {
  path: ".github/workflows/handle-task-dispatch.yml",
  head_branch: "main",
  conclusion: "success",
};

function keys() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return { publicKey: pair.publicKey.toString("base64"), privateKey: pair.privateKey };
}

function reader(runIds: number[]) {
  return {
    async get(path: string): Promise<unknown> {
      if (path.includes("/actions/artifacts?name=")) {
        return { artifacts: runIds.map((id) => ({ expired: false, workflow_run: { id } })) };
      }
      if (path.includes("/actions/runs/")) return trustedRun;
      throw new Error("Unexpected GitHub endpoint");
    },
  };
}

function options(root: string, publicKey: string, fixture: string, runs: number[], isPrivate: boolean) {
  return {
    workRoot: join(root, "work"),
    repository,
    project,
    bootstrapRef,
    requestId: "request-1",
    runId: "42000001",
    runAttempt: "1",
    isPrivate,
    key: isPrivate ? artifactSecret : null,
    reader: reader(runs),
    controlRepository: "fongap-labs/action-worker",
    inboundPublicKey: publicKey,
    download: async (_id: number, _name: string, destination: string) => {
      await cp(fixture, destination, { recursive: true });
    },
  };
}

test("trusted preparation sends a new task only an authenticated encrypted manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-prepare-state-"));
  try {
    const key = keys();
    const prepared = await prepareTrustedTaskState(
      options(root, key.publicKey, join(root, "unused"), [], true)
    );
    assert.equal(prepared.restored, false);
    assert.doesNotMatch(prepared.envelope.toString("utf8"), /fongap-labs|example|manifest/);
    const opened = openTaskTransfer(
      prepared.envelope,
      {
        repository, project, bootstrap_ref: bootstrapRef,
        request_id: "request-1", run_id: "42000001", run_attempt: "1",
        purpose: "state-to-task",
      },
      key.privateKey
    );
    const target = join(root, "unpacked");
    await unpackTaskTransferFiles(opened, target);
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    assert.equal(manifest.repository, repository);
    assert.equal(manifest.project, project);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted preparation restores an AWSEAL1 historical private state before encrypting it to the task", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-prepare-state-"));
  try {
    const source = join(root, "source");
    const artifact = join(root, "artifact");
    await mkdir(artifact);
    await writeTaskStateManifest(source, repository, project, "b".repeat(40));
    await writeFile(join(source, "cursor.txt"), "42");
    await sealStateDirectory(artifactSecret, source, repository, project, join(artifact, sealedStateFile));
    const pair = keys();
    const prepared = await prepareTrustedTaskState(options(root, pair.publicKey, artifact, [5], true));
    assert.equal(prepared.restored, true);
    const opened = openTaskTransfer(
      prepared.envelope,
      {
        repository, project, bootstrap_ref: bootstrapRef,
        request_id: "request-1", run_id: "42000001", run_attempt: "1",
        purpose: "state-to-task",
      },
      pair.privateKey
    );
    const destination = join(root, "restored");
    await unpackTaskTransferFiles(opened, destination);
    assert.equal(await readFile(join(destination, "cursor.txt"), "utf8"), "42");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical private archive with a symlink fails closed before trusted extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-prepare-state-"));
  try {
    const source = join(root, "source");
    const artifact = join(root, "artifact");
    await mkdir(artifact);
    await writeTaskStateManifest(source, repository, project, bootstrapRef);
    await symlink("manifest.json", join(source, "malicious-link"));
    await sealStateDirectory(artifactSecret, source, repository, project, join(artifact, sealedStateFile));
    const pair = keys();
    await assert.rejects(
      prepareTrustedTaskState(options(root, pair.publicKey, artifact, [5], true)),
      /archive validation/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private historical state is not replaced with a new key when the old key is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-prepare-state-"));
  try {
    const pair = keys();
    const settings = { ...options(root, pair.publicKey, root, [], true), key: null };
    await assert.rejects(prepareTrustedTaskState(settings), /existing protected artifact key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
