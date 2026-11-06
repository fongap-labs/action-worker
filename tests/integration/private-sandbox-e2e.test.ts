import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeTrustedTaskArtifacts } from "../../scripts/finalize-trusted-task-artifacts.ts";
import { prepareTrustedTaskState } from "../../scripts/prepare-trusted-task-state.ts";
import { privateTaskDockerArguments } from "../../scripts/private-task-container.ts";
import { stampPrivateTaskOutput } from "../../scripts/stamp-private-task-output.ts";
import {
  openBytes,
  openStateFile,
  sealedLogFile,
  sealedStateFile,
} from "../../scripts/task-state.ts";
import { runTaskTransferCommand } from "../../scripts/task-transfer-job.ts";

const repository = "fongap-labs/synthetic-private-e2e";
const project = "sandbox";
const bootstrapRef = "c".repeat(40);
const runId = "42000001";
const requestId = "synthetic-e2e-1";
const artifactSecret = Buffer.alloc(32, 31);
const syntheticDigest = `ghcr.io/fongap-labs/private-sandbox@sha256:${"a".repeat(64)}`;
const requestedImage = process.env.AW_SANDBOX_TEST_IMAGE_ID ?? "";

function keypair() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return { publicKey: pair.publicKey.toString("base64"), privateKey: pair.privateKey };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-real-private-e2e-"));
  const source = join(root, "source");
  const state = join(root, "private-state");
  await mkdir(source);
  await mkdir(state);
  await mkdir(join(state, "current"));
  return { root, source, state };
}

function dockerRun(
  source: string,
  state: string,
  log: string,
  image: string,
  identity: { requestId: string }
): number {
  const args = privateTaskDockerArguments({
    image: syntheticDigest,
    sourceDirectory: source,
    stateDirectory: state,
    logFile: log,
    repository,
    project,
    bootstrapRef,
    requestId: identity.requestId,
    userId: process.getuid?.() ?? 0,
    groupId: process.getgid?.() ?? 0,
    taskCredentials: {},
  });
  const imageIndex = args.indexOf(syntheticDigest);
  assert.ok(imageIndex >= 0);
  args[imageIndex] = image;
  const fd = openSync(log, "wx", 0o600);
  try {
    const result = spawnSync("docker", args, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", fd, fd],
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    return result.status ?? 124;
  } finally {
    closeSync(fd);
  }
}

test("real Docker sandbox and private state/log handoff, including next-run restoration", {
  timeout: 180_000,
}, async () => {
  assert.match(requestedImage, /^sha256:[a-f0-9]{64}$/);
  const root = await fixture();
  try {
    const inbound = keypair();
    const outbound = keypair();
    const prepared = await prepareTrustedTaskState({
      workRoot: join(root.root, "trusted-prepare"),
      repository,
      project,
      bootstrapRef,
      requestId,
      runId,
      runAttempt: "1",
      isPrivate: true,
      key: artifactSecret,
      reader: {
        async get(path: string): Promise<unknown> {
          if (path.includes("/actions/artifacts?name=")) return { artifacts: [] };
          throw new Error("Unexpected request");
        },
      },
      controlRepository: "fongap-labs/action-worker",
      inboundPublicKey: inbound.publicKey,
      download: async () => {
        throw new Error("Unexpected historical download");
      },
    });
    assert.equal(prepared.restored, false);
    const encryptedInput = join(root.root, "inbound.seal");
    await writeFile(encryptedInput, prepared.envelope);
    await runTaskTransferCommand(
      "open-state",
      "state-to-task",
      encryptedInput,
      join(root.state, "previous"),
      {
        TASK_SOURCE_REPOSITORY: repository,
        PROJECT: project,
        BOOTSTRAP_REF: bootstrapRef,
        REQUEST_ID: requestId,
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: "1",
        AW_TASK_TRANSFER_ROLE: "task",
        AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: inbound.privateKey,
      }
    );
    await writeFile(
      join(root.source, "bootstrap.sh"),
      [
        "set -Eeuo pipefail",
        "test -r /task-state/previous/manifest.json",
        'test -z "${AW_ARTIFACT_KEY:-}"',
        'test -z "${AW_APP_PRIVATE_KEY:-}"',
        'test -z "${GH_TOKEN:-}"',
        "test ! -e /var/run/docker.sock",
        "test ! -e /host-secret",
        "if touch /task-source/prohibited 2>/dev/null; then exit 71; fi",
        "if (timeout 3 bash -c 'echo x >/dev/tcp/1.1.1.1/443' 2>/dev/null); then exit 72; fi",
        "echo 43 > /task-state/current/cursor.txt",
        "echo PRIVATE_SENTINEL_CHECK in-container-output",
        "",
      ].join("\n")
    );
    await chmod(join(root.source, "bootstrap.sh"), 0o755);
    const log = join(root.root, "private.log");
    assert.equal(dockerRun(root.source, root.state, log, requestedImage, { requestId }), 0);
    assert.match(await readFile(log, "utf8"), /PRIVATE_SENTINEL_CHECK/);
    await assert.rejects(readFile(join(root.source, "prohibited")), /ENOENT/);

    await stampPrivateTaskOutput(join(root.state, "current"), repository, project, bootstrapRef);
    const stateSeal = join(root.root, "outbound-state.seal");
    const logSeal = join(root.root, "outbound-log.seal");
    const outboundEnv = {
      TASK_SOURCE_REPOSITORY: repository,
      PROJECT: project,
      BOOTSTRAP_REF: bootstrapRef,
      REQUEST_ID: requestId,
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: "1",
      AW_TASK_TRANSFER_ROLE: "task",
      AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY: outbound.publicKey,
    };
    await runTaskTransferCommand(
      "seal-state", "state-from-task", join(root.state, "current"), stateSeal, outboundEnv
    );
    await runTaskTransferCommand("seal-log", "log-from-task", log, logSeal, outboundEnv);
    const sealedState = await readFile(stateSeal);
    const sealedLog = await readFile(logSeal);
    assert.doesNotMatch(sealedState.toString("utf8"), /PRIVATE_SENTINEL_CHECK|cursor.txt/);
    assert.doesNotMatch(sealedLog.toString("utf8"), /PRIVATE_SENTINEL_CHECK/);
    const finalized = await finalizeTrustedTaskArtifacts({
      repository,
      project,
      bootstrapRef,
      requestId,
      runId,
      runAttempt: "1",
      isPrivate: true,
      artifactKey: artifactSecret,
      outboundPrivateKey: outbound.privateKey,
      encryptedStatePath: stateSeal,
      encryptedLogPath: logSeal,
      workRoot: join(root.root, "trusted-finalize"),
    });
    assert.ok(finalized.stateUploadPath);
    assert.ok(finalized.logUploadPath);
    const nextRunState = join(root.root, "next-run");
    await openStateFile(
      artifactSecret,
      join(finalized.stateUploadPath, sealedStateFile),
      repository,
      project,
      nextRunState,
      true
    );
    assert.equal(await readFile(join(nextRunState, "cursor.txt"), "utf8"), "43\n");
    const encryptedHistoricalLog = await readFile(join(finalized.logUploadPath, sealedLogFile));
    assert.match(
      openBytes(artifactSecret, "task-log", repository, project, encryptedHistoricalLog).toString(),
      /PRIVATE_SENTINEL_CHECK/
    );
    await assert.rejects(
      finalizeTrustedTaskArtifacts({
        repository,
        project,
        bootstrapRef,
        requestId,
        runId,
        runAttempt: "2",
        isPrivate: true,
        artifactKey: artifactSecret,
        outboundPrivateKey: outbound.privateKey,
        encryptedStatePath: stateSeal,
        encryptedLogPath: logSeal,
        workRoot: join(root.root, "replay-failure"),
      }),
      /authentication/
    );
  } finally {
    await rm(root.root, { recursive: true, force: true });
  }
});

test("real failing Docker task cannot silently produce successful recoverable state", {
  timeout: 60_000,
}, async () => {
  assert.match(requestedImage, /^sha256:[a-f0-9]{64}$/);
  const { root, source, state } = await fixture();
  try {
    await writeFile(
      join(source, "bootstrap.sh"),
      [
        "echo PRIVATE_FAILURE_SENTINEL",
        "echo invalid > /task-state/current/cursor.txt",
        "exit 19",
      "",
      ].join("\n")
    );
    const log = join(root, "failed-private.log");
    assert.equal(dockerRun(source, state, log, requestedImage, { requestId: "failed-task" }), 19);
    assert.match(await readFile(log, "utf8"), /PRIVATE_FAILURE_SENTINEL/);
    // This output is not eligible for the workflow's state-stamping step.
    const stateManifest = join(state, "current", "manifest.json");
    await assert.rejects(readFile(stateManifest), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
