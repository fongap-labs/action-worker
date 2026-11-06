import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { buildTaskStateManifest } from "./task-state.ts";
import { packTaskTransferFiles } from "./task-transfer-files.ts";

function reject(): never {
  throw new CliError("Private task state cannot be sealed from an untrusted output tree.", 66);
}

// Only call on a successful isolated task. Never overwrite a task-controlled
// manifest: it could be a symlink or a forged identity. All files are inspected
// before the fresh manifest is created.
export async function stampPrivateTaskOutput(
  directory: string,
  repository: string,
  project: string,
  bootstrapRef: string
): Promise<void> {
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    !/^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(project) ||
    !/^[a-f0-9]{40}$/.test(bootstrapRef)
  )
    reject();
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (await realpath(directory)) !== directory) {
    reject();
  }
  // Check unsafe links, hardlinks, special files and bounded output size before
  // touching task output, with the same validation used by the encrypted handoff.
  await packTaskTransferFiles(directory);

  const manifestPath = join(directory, "manifest.json");
  const handle = await open(
    manifestPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    const manifest = buildTaskStateManifest(repository, project, bootstrapRef);
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const [directory = ""] = process.argv.slice(2);
  await stampPrivateTaskOutput(
    directory,
    process.env.TASK_SOURCE_REPOSITORY ?? "",
    process.env.PROJECT ?? "",
    process.env.BOOTSTRAP_REF ?? ""
  );
  console.log("Isolated private output passed state integrity checks.");
}

if (isMain(import.meta.url)) main().catch(handleError);
