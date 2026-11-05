import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GithubReader, githubEnvironment } from "./github-api.ts";
import { CliError, handleError, isMain, runCommand } from "./runtime-command.ts";
import {
  artifactKey,
  restoreTaskState,
  type RestoreOptions,
  verifyTaskStateDirectory,
  writeTaskStateManifest,
} from "./task-state.ts";
import { sealTaskTransfer, type TransferIdentity } from "./task-transfer-envelope.ts";
import { packTaskTransferFiles } from "./task-transfer-files.ts";

export type StatePreparationOptions = Omit<RestoreOptions, "stateRoot" | "strictArchiveValidation"> & {
  bootstrapRef: string;
  requestId: string;
  runId: string;
  runAttempt: string;
  inboundPublicKey: string;
  workRoot: string;
};

export type PreparedTaskState = {
  envelope: Buffer;
  restored: boolean;
};

export async function prepareTrustedTaskState(
  options: StatePreparationOptions
): Promise<PreparedTaskState> {
  if (options.isPrivate && options.key === null) {
    throw new CliError("Private state recovery requires the existing protected artifact key.", 77);
  }
  const stateRoot = join(options.workRoot, "task-state");
  await mkdir(join(stateRoot, "previous"), { recursive: true, mode: 0o700 });
  await mkdir(join(stateRoot, "current"), { recursive: true, mode: 0o700 });
  const restoredMessage = await restoreTaskState({
    ...options,
    stateRoot,
    strictArchiveValidation: true,
  });
  const previous = join(stateRoot, "previous");
  const restored = !restoredMessage.startsWith("No previous task state");
  if (!restored) {
    await writeTaskStateManifest(
      previous,
      options.repository,
      options.project,
      options.bootstrapRef
    );
  }
  if (!(await verifyTaskStateDirectory(previous, options.repository, options.project))) {
    throw new CliError("Historical task state has no trusted matching manifest.", 66);
  }
  const identity: TransferIdentity = {
    repository: options.repository,
    project: options.project,
    bootstrap_ref: options.bootstrapRef,
    request_id: options.requestId,
    run_id: options.runId,
    run_attempt: options.runAttempt,
    purpose: "state-to-task",
  };
  const bytes = await packTaskTransferFiles(previous);
  const envelope = sealTaskTransfer(bytes, identity, options.inboundPublicKey);
  return { envelope, restored };
}

async function main(): Promise<void> {
  const [outputFile = ""] = process.argv.slice(2);
  const repository = process.env.TASK_SOURCE_REPOSITORY ?? "";
  const project = process.env.PROJECT ?? "";
  const visibility = process.env.TASK_SOURCE_PRIVATE ?? "";
  const existingKey = process.env.AW_ARTIFACT_KEY ?? "";
  const token = process.env.GH_TOKEN ?? "";
  const publicKey = process.env.AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY ?? "";
  if (
    !outputFile ||
    !token ||
    !publicKey ||
    (visibility !== "true" && visibility !== "false")
  ) {
    throw new CliError("Trusted state preparation is missing required configuration.", 77);
  }
  const root = await mkdtemp(join(tmpdir(), "aw-state-prepare-"));
  try {
    const prepared = await prepareTrustedTaskState({
      workRoot: root,
      repository,
      project,
      bootstrapRef: process.env.BOOTSTRAP_REF ?? "",
      requestId: process.env.REQUEST_ID ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
      isPrivate: visibility === "true",
      key: existingKey ? artifactKey(existingKey) : null,
      reader: new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token),
      controlRepository: process.env.GITHUB_REPOSITORY ?? "",
      inboundPublicKey: publicKey,
      download: async (runId, name, destination) => {
        await runCommand(
          "gh",
          ["run", "download", String(runId), "-R", process.env.GITHUB_REPOSITORY ?? "", "-n", name, "-D", destination],
          { env: githubEnvironment(token) }
        );
      },
    });
    await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
    await writeFile(outputFile, prepared.envelope, { flag: "wx", mode: 0o600 });
    console.log(prepared.restored ? "Trusted task state prepared from prior run." : "Trusted new task state prepared.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
