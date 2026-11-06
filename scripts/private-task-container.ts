import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const pinnedImage = /^ghcr\.io\/fongap-labs\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const requestPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const maxExecutionMs = 60 * 60 * 1000;

export type PrivateTaskContainerSettings = {
  image: string;
  sourceDirectory: string;
  stateDirectory: string;
  publicationDirectory?: string;
  logFile: string;
  repository: string;
  project: string;
  bootstrapRef: string;
  requestId: string;
  userId: number;
  groupId: number;
  taskCredentials: Record<string, string>;
};

function reject(): never {
  throw new CliError("Private task container security contract rejected execution.", 77);
}

export function privateTaskDockerArguments(settings: PrivateTaskContainerSettings): string[] {
  if (
    !pinnedImage.test(settings.image) ||
    !repositoryPattern.test(settings.repository) ||
    !projectPattern.test(settings.project) ||
    !commitPattern.test(settings.bootstrapRef) ||
    !requestPattern.test(settings.requestId) ||
    !Number.isSafeInteger(settings.userId) ||
    !Number.isSafeInteger(settings.groupId) ||
    settings.userId <= 0 ||
    settings.groupId <= 0 ||
    !isAbsolute(settings.sourceDirectory) ||
    !isAbsolute(settings.stateDirectory) ||
    /[,\r\n\0]/.test(settings.sourceDirectory) ||
    /[,\r\n\0]/.test(settings.stateDirectory) ||
    (settings.publicationDirectory !== undefined &&
      (!isAbsolute(settings.publicationDirectory) ||
        /[,\r\n\0]/.test(settings.publicationDirectory))) ||
    Object.keys(settings.taskCredentials).length !== 0
  )
    reject();

  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=1g",
    "--cpus=2",
    "--user",
    `${settings.userId}:${settings.groupId}`,
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--mount",
    `type=bind,source=${settings.sourceDirectory},target=/task-source,readonly`,
    "--mount",
    `type=bind,source=${settings.stateDirectory},target=/task-state`,
    ...(settings.publicationDirectory
      ? [
          "--mount",
          `type=bind,source=${settings.publicationDirectory},target=/task-output`,
          "-e",
          "RUNNER_TEMP=/task-output",
          "-e",
          "AW_TASK_PUBLICATION_DIR=/task-output/action-worker-publication",
        ]
      : []),
    "-e",
    "AW_TASK_STATE_DIR=/task-state",
    "-e",
    `PROJECT=${settings.project}`,
    "-e",
    `BOOTSTRAP_REF=${settings.bootstrapRef}`,
    "-e",
    `REQUEST_ID=${settings.requestId}`,
    "-e",
    `TASK_SOURCE_REPOSITORY=${settings.repository}`,
    settings.image,
    "/bin/bash",
    "/task-source/bootstrap.sh",
    settings.project,
    settings.bootstrapRef,
    settings.requestId,
  ];
  return args;
}

async function requiredDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== resolved) reject();
  return resolved;
}

export async function runPrivateTaskContainer(
  settings: PrivateTaskContainerSettings
): Promise<void> {
  // A private pilot without approved credential delivery must fail closed rather than
  // acquiring a GitHub token or silently borrowing the central runner environment.
  if (Object.keys(settings.taskCredentials).length !== 0) reject();
  const source = await requiredDirectory(settings.sourceDirectory);
  const state = await requiredDirectory(settings.stateDirectory);
  const publication = settings.publicationDirectory
    ? await requiredDirectory(settings.publicationDirectory)
    : undefined;
  const roots = [source, state, ...(publication ? [publication] : [])];
  if (
    roots.some((root, index) =>
      roots.some(
        (other, otherIndex) =>
          index !== otherIndex && (root === other || root.startsWith(`${other}/`))
      )
    )
  )
    reject();
  const args = privateTaskDockerArguments({
    ...settings,
    sourceDirectory: source,
    stateDirectory: state,
    publicationDirectory: publication,
  });
  const log = await open(
    settings.logFile,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    // Never forward the host process environment or a Docker socket mount.
    // Private task stdout/stderr stays on this runner until the trusted envelope is sealed.
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const child = spawn("docker", args, {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdio: ["ignore", log.fd, log.fd],
        timeout: maxExecutionMs,
        killSignal: "SIGKILL",
      });
      child.on("error", rejectStatus);
      child.on("close", (code, signal) => {
        resolveStatus(signal ? 124 : (code ?? 1));
      });
    });
    if (status !== 0) {
      throw new CliError(
        "Private task container failed; output retained for encrypted handling.",
        66
      );
    }
  } finally {
    await log.close();
  }
}

async function main(): Promise<void> {
  const image = process.env.AW_TASK_CONTAINER_IMAGE ?? "";
  const sourceDirectory = process.env.AW_SOURCE_DIR ?? "";
  const stateDirectory = process.env.AW_TASK_STATE_DIR ?? "";
  const publicationDirectory = process.env.AW_TASK_PUBLICATION_ROOT ?? "";
  const logFile = process.env.AW_TASK_PRIVATE_LOG_FILE ?? "";
  const userId = process.getuid?.() ?? 0;
  const groupId = process.getgid?.() ?? 0;
  if (!logFile || !isAbsolute(logFile)) reject();
  await runPrivateTaskContainer({
    image,
    sourceDirectory,
    stateDirectory,
    ...(publicationDirectory ? { publicationDirectory } : {}),
    logFile,
    repository: process.env.TASK_SOURCE_REPOSITORY ?? "",
    project: process.env.PROJECT ?? "",
    bootstrapRef: process.env.BOOTSTRAP_REF ?? "",
    requestId: process.env.REQUEST_ID ?? "",
    userId,
    groupId,
    taskCredentials: {},
  });
  console.log("Private task container completed.");
}

if (isMain(import.meta.url)) main().catch(handleError);
