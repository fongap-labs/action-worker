import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { verifyTaskStateDirectory } from "./task-state.ts";
import {
  openTaskTransfer,
  sealTaskTransfer,
  type TransferIdentity,
  type TransferPurpose,
} from "./task-transfer-envelope.ts";
import { packTaskTransferFiles, unpackTaskTransferFiles } from "./task-transfer-files.ts";

// Only the caller's fixed, trusted path is allowed. No task-supplied command or path
// is ever evaluated as code on a privileged runner.
const MAX_ENVELOPE_BYTES = 24 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

export type TransferCommand = "seal-state" | "open-state" | "seal-log" | "open-log";
type Environment = Record<string, string | undefined>;

function identityFrom(env: Environment, purpose: TransferPurpose): TransferIdentity {
  return {
    repository: env.TASK_SOURCE_REPOSITORY ?? "",
    project: env.PROJECT ?? "",
    bootstrap_ref: env.BOOTSTRAP_REF ?? "",
    request_id: env.REQUEST_ID ?? "",
    run_id: env.GITHUB_RUN_ID ?? "",
    run_attempt: env.GITHUB_RUN_ATTEMPT ?? "",
    purpose,
  };
}

type TransferRole = "trusted-prepare" | "task" | "trusted-finalize";

function requireTransferBoundary(
  env: Environment,
  command: TransferCommand,
  purpose: TransferPurpose
): void {
  const expectedRole: TransferRole =
    command === "seal-state" && purpose === "state-to-task"
      ? "trusted-prepare"
      : (command === "open-state" && purpose === "state-to-task") ||
          (command === "seal-state" && purpose === "state-from-task") ||
          (command === "seal-log" && purpose === "log-from-task")
        ? "task"
        : "trusted-finalize";
  if (env.AW_TASK_TRANSFER_ROLE !== expectedRole) {
    throw new CliError("Task transfer phase does not match its trusted runner role.", 77);
  }
  const forbidden =
    expectedRole === "task"
      ? [
          "AW_ARTIFACT_KEY",
          "AW_ADMIN_TOKEN",
          "AW_APP_PRIVATE_KEY",
          "AW_STATUS_KEYRING",
          "AW_PUBLICATION_PRIVATE_KEY",
          "AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY",
          "AW_TASK_TRANSFER_INBOUND_PUBLIC_KEY",
        ]
      : expectedRole === "trusted-prepare"
        ? ["AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY", "AW_TASK_TRANSFER_OUTBOUND_PRIVATE_KEY"]
        : ["AW_TASK_TRANSFER_INBOUND_PRIVATE_KEY", "AW_TASK_TRANSFER_OUTBOUND_PUBLIC_KEY"];
  for (const name of forbidden) {
    if (env[name]) {
      throw new CliError("Task transfer runner contains a forbidden credential role.", 77);
    }
  }
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) {
      throw new CliError("Task transfer source file is not a bounded regular file.", 66);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.nlink !== 1) {
      throw new CliError("Task transfer source file changed during reading.", 66);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

async function requireStateManifest(path: string, identity: TransferIdentity): Promise<void> {
  if (!(await verifyTaskStateDirectory(path, identity.repository, identity.project))) {
    throw new CliError("Task transfer source state manifest does not match its identity.", 66);
  }
  if (identity.purpose === "state-from-task") {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as unknown;
    } catch {
      throw new CliError("Task transfer source state manifest is invalid.", 66);
    }
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("bootstrap_ref" in manifest) ||
      manifest.bootstrap_ref !== identity.bootstrap_ref
    ) {
      throw new CliError("Task transfer source state manifest has a mismatched commit.", 66);
    }
  }
}

function keyFor(env: Environment, command: TransferCommand): string {
  const name =
    command === "seal-state" || command === "seal-log"
      ? "AW_TASK_TRANSFER_RECIPIENT_PUBLIC_KEY"
      : "AW_TASK_TRANSFER_RECIPIENT_PRIVATE_KEY";
  const key = env[name] ?? "";
  if (!key) throw new CliError("Task transfer key is not configured.", 77);
  return key;
}

export async function runTaskTransferCommand(
  command: TransferCommand,
  purpose: TransferPurpose,
  from: string,
  to: string,
  env: Environment
): Promise<void> {
  if (!from || !to || from === to) {
    throw new CliError("Task transfer file paths are invalid.", 64);
  }
  const identity = identityFrom(env, purpose);
  requireTransferBoundary(env, command, purpose);
  const inbound = purpose === "state-to-task";
  const outbound = purpose === "state-from-task" || purpose === "log-from-task";
  if (
    (command === "seal-state" || command === "open-state") &&
    !(inbound || purpose === "state-from-task")
  ) {
    throw new CliError("Task transfer state command has the wrong purpose.", 64);
  }
  if ((command === "seal-log" || command === "open-log") && !outbound) {
    throw new CliError("Task transfer log command has the wrong purpose.", 64);
  }
  if ((command === "seal-log" || command === "open-log") && purpose !== "log-from-task") {
    throw new CliError("Task transfer log purpose is invalid.", 64);
  }

  if (command === "seal-state") {
    await requireStateManifest(from, identity);
    const contents = await packTaskTransferFiles(from);
    const envelope = sealTaskTransfer(contents, identity, keyFor(env, command));
    await writeExclusive(to, envelope);
  } else if (command === "open-state") {
    const envelope = await readBounded(from, MAX_ENVELOPE_BYTES);
    const opened = openTaskTransfer(envelope, identity, keyFor(env, command));
    try {
      await unpackTaskTransferFiles(opened, to);
      await requireStateManifest(to, identity);
    } catch {
      // Never delete a destination that could predate this operation (for example EEXIST).
      // The caller uses an isolated temporary workspace and must discard it after failure.
      throw new CliError("Task transfer state validation failed.", 66);
    }
  } else if (command === "seal-log") {
    const contents = await readBounded(from, MAX_LOG_BYTES);
    const envelope = sealTaskTransfer(contents, identity, keyFor(env, command));
    await writeExclusive(to, envelope);
  } else {
    const envelope = await readBounded(from, MAX_ENVELOPE_BYTES);
    const contents = openTaskTransfer(envelope, identity, keyFor(env, command));
    await writeExclusive(to, contents);
  }
}

async function main(): Promise<void> {
  const [command = "", purpose = "", from = "", to = ""] = process.argv.slice(2);
  if (
    !["seal-state", "open-state", "seal-log", "open-log"].includes(command) ||
    !["state-to-task", "state-from-task", "log-from-task"].includes(purpose)
  ) {
    throw new CliError(
      "Usage: task-transfer-job.ts seal-state|open-state|seal-log|open-log purpose from to",
      64
    );
  }
  await runTaskTransferCommand(
    command as TransferCommand,
    purpose as TransferPurpose,
    from,
    to,
    process.env
  );
  console.log("Task transfer completed.");
}

if (isMain(import.meta.url)) main().catch(handleError);
