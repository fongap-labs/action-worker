import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import {
  artifactKey,
  sealBytes,
  sealedLogFile,
  sealedStateFile,
  sealStateDirectory,
} from "./task-state.ts";
import { runTaskTransferCommand } from "./task-transfer-job.ts";

type Environment = Record<string, string | undefined>;

export type TaskFinalizationOptions = {
  repository: string;
  project: string;
  bootstrapRef: string;
  requestId: string;
  runId: string;
  runAttempt: string;
  isPrivate: boolean;
  artifactKey: Buffer | null;
  outboundPrivateKey: string;
  encryptedStatePath: string | null;
  encryptedLogPath: string | null;
  workRoot: string;
};

export type FinalizedTaskArtifacts = {
  stateUploadPath: string | null;
  logUploadPath: string | null;
};

export async function finalizeTrustedTaskArtifacts(
  options: TaskFinalizationOptions
): Promise<FinalizedTaskArtifacts> {
  if (options.isPrivate && options.artifactKey === null) {
    throw new CliError("Trusted finalization requires the existing artifact key.", 77);
  }
  if (options.encryptedStatePath === null && options.encryptedLogPath === null) {
    throw new CliError("Trusted finalization received no encrypted task result.", 77);
  }
  const trustedEnv: Environment = {
    TASK_SOURCE_REPOSITORY: options.repository,
    PROJECT: options.project,
    BOOTSTRAP_REF: options.bootstrapRef,
    REQUEST_ID: options.requestId,
    GITHUB_RUN_ID: options.runId,
    GITHUB_RUN_ATTEMPT: options.runAttempt,
    AW_TASK_TRANSFER_ROLE: "trusted-finalize",
    AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY: options.outboundPrivateKey,
  };
  await mkdir(options.workRoot, { recursive: true, mode: 0o700 });
  let stateUploadPath: string | null = null;
  let logUploadPath: string | null = null;
  if (options.encryptedStatePath !== null) {
    const current = join(options.workRoot, "current");
    await runTaskTransferCommand(
      "open-state",
      "state-from-task",
      options.encryptedStatePath,
      current,
      trustedEnv
    );
    if (options.isPrivate) {
      const sealed = join(options.workRoot, "sealed");
      await mkdir(sealed, { mode: 0o700 });
      await sealStateDirectory(
        options.artifactKey as Buffer,
        current,
        options.repository,
        options.project,
        join(sealed, sealedStateFile)
      );
      stateUploadPath = sealed;
    } else {
      // Preserve the historical public-source artifact shape.
      stateUploadPath = current;
    }
  }
  if (options.encryptedLogPath !== null) {
    if (!options.isPrivate || options.artifactKey === null) {
      throw new CliError(
        "Trusted private log finalization requires the private-source contract.",
        77
      );
    }
    const log = join(options.workRoot, "private-log.txt");
    await runTaskTransferCommand(
      "open-log",
      "log-from-task",
      options.encryptedLogPath,
      log,
      trustedEnv
    );
    const sealed = join(options.workRoot, "sealed-log");
    await mkdir(sealed, { mode: 0o700 });
    const bytes = await readFile(log);
    const ciphertext = sealBytes(
      options.artifactKey,
      "task-log",
      options.repository,
      options.project,
      bytes
    );
    await writeFile(join(sealed, sealedLogFile), ciphertext, { flag: "wx", mode: 0o600 });
    await rm(log, { force: true });
    logUploadPath = sealed;
  }
  return { stateUploadPath, logUploadPath };
}

async function main(): Promise<void> {
  const [statePath = "", logPath = "", outputRoot = ""] = process.argv.slice(2);
  const visibility = process.env.TASK_SOURCE_PRIVATE ?? "";
  const key = process.env.AW_ARTIFACT_KEY ?? "";
  const privateKey = process.env.AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY ?? "";
  if (!outputRoot || !privateKey || (visibility !== "true" && visibility !== "false")) {
    throw new CliError("Trusted task finalization configuration is missing.", 77);
  }
  const root = await mkdtemp(join(tmpdir(), "aw-task-finalization-"));
  try {
    const prepared = await finalizeTrustedTaskArtifacts({
      repository: process.env.TASK_SOURCE_REPOSITORY ?? "",
      project: process.env.PROJECT ?? "",
      bootstrapRef: process.env.BOOTSTRAP_REF ?? "",
      requestId: process.env.REQUEST_ID ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
      isPrivate: visibility === "true",
      artifactKey: key ? artifactKey(key) : null,
      outboundPrivateKey: privateKey,
      encryptedStatePath: statePath || null,
      encryptedLogPath: logPath || null,
      workRoot: root,
    });
    // Copying encrypted products into an isolated output directory is the only handoff.
    // Do not publish these paths until the caller uses encrypted private-artifact semantics.
    await mkdir(outputRoot, { mode: 0o700 });
    if (prepared.stateUploadPath) {
      await cp(prepared.stateUploadPath, join(outputRoot, "state"), { recursive: true });
    }
    if (prepared.logUploadPath) {
      await cp(prepared.logUploadPath, join(outputRoot, "log"), { recursive: true });
    }
    console.log("Trusted task finalization completed.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
