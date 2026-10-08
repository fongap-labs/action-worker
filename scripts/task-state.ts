import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, runCommand } from "./runtime-command.ts";

// Task state is carried between runs in a workflow artifact. The artifact name must identify one
// (repository, project) pair exactly: replacing unsafe characters with "-" lets "a/b-c" + "d" and
// "a/b" + "c-d" share a name, and so share state. A hash of both values, joined by NUL (which cannot
// occur in either), has no such collisions. The manifest written next to the state lets the restore
// step reject an artifact that belongs to somebody else.

export const taskStateManifestFile = "manifest.json";

export type TaskStateManifest = {
  repository: string;
  project: string;
  bootstrap_ref: string;
};

function requireText(value: string, label: string): void {
  if (value === "" || value.includes("\0")) {
    throw new CliError(`Task state ${label} is invalid.`, 64);
  }
}

export function taskStateArtifactName(repository: string, project: string): string {
  requireText(repository, "repository");
  requireText(project, "project");
  const digest = createHash("sha256").update(`${repository}\0${project}`, "utf8").digest("hex");
  return `task-state-${digest.slice(0, 32)}`;
}

export function buildTaskStateManifest(
  repository: string,
  project: string,
  bootstrapRef: string
): TaskStateManifest {
  requireText(repository, "repository");
  requireText(project, "project");
  return { repository, project, bootstrap_ref: bootstrapRef };
}

// True only when the manifest is valid JSON naming exactly this repository and project.
export function taskStateManifestMatches(
  raw: string,
  repository: string,
  project: string
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  return isJsonRecord(value) && value.repository === repository && value.project === project;
}

export async function writeTaskStateManifest(
  directory: string,
  repository: string,
  project: string,
  bootstrapRef: string
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const manifest = buildTaskStateManifest(repository, project, bootstrapRef);
  await writeFile(
    join(directory, taskStateManifestFile),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

export async function verifyTaskStateDirectory(
  directory: string,
  repository: string,
  project: string
): Promise<boolean> {
  try {
    return taskStateManifestMatches(
      await readFile(join(directory, taskStateManifestFile), "utf8"),
      repository,
      project
    );
  } catch {
    return false;
  }
}

// Artifacts of the public control repository can be downloaded by any signed-in GitHub user, so
// state and logs of a private task source leave the runner only encrypted with AW_ARTIFACT_KEY
// (AES-256-GCM). The additional data binds a sealed file to one kind, repository and project, so a
// sealed file cannot be replayed into another task.
export const sealedStateFile = "state.seal";
export const sealedLogFile = "task-log.seal";
const sealMagic = Buffer.from("AWSEAL1", "utf8");
const taskWorkflowPath = ".github/workflows/handle-task-dispatch.yml";

export type SealKind = "task-state" | "task-log";

export function artifactKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new CliError("AW_ARTIFACT_KEY must be 32 bytes encoded as base64.", 64);
  }
  return key;
}

function sealLabel(kind: SealKind, repository: string, project: string): Buffer {
  requireText(repository, "repository");
  requireText(project, "project");
  return Buffer.from([kind, repository, project].join("\0"), "utf8");
}

export function sealBytes(
  key: Buffer,
  kind: SealKind,
  repository: string,
  project: string,
  plain: Buffer
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(sealLabel(kind, repository, project));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([sealMagic, iv, cipher.getAuthTag(), body]);
}

export function openBytes(
  key: Buffer,
  kind: SealKind,
  repository: string,
  project: string,
  sealed: Buffer
): Buffer {
  const headerLength = sealMagic.length + 12 + 16;
  if (sealed.length < headerLength || !sealed.subarray(0, sealMagic.length).equals(sealMagic)) {
    throw new CliError("Sealed artifact has no valid header.", 65);
  }
  const iv = sealed.subarray(sealMagic.length, sealMagic.length + 12);
  const tag = sealed.subarray(sealMagic.length + 12, headerLength);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(sealLabel(kind, repository, project));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(sealed.subarray(headerLength)), decipher.final()]);
  } catch {
    throw new CliError("Sealed artifact does not belong to this key, repository and project.", 65);
  }
}

// GNU tar reads "C:..." as a remote host and backslashes as escapes, so it only sees relative
// paths with forward slashes, resolved from the temporary directory.
function tarPath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/") || ".";
}

async function withTempDirectory<T>(use: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "aw-seal-"));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function sealStateDirectory(
  key: Buffer,
  directory: string,
  repository: string,
  project: string,
  outFile: string
): Promise<void> {
  await withTempDirectory(async (temp) => {
    const archive = join(temp, "state.tar.gz");
    await runCommand("tar", ["-czf", "state.tar.gz", "-C", tarPath(temp, directory), "."], {
      cwd: temp,
    });
    await writeFile(
      outFile,
      sealBytes(key, "task-state", repository, project, await readFile(archive))
    );
  });
}

export async function openStateFile(
  key: Buffer,
  sealedFile: string,
  repository: string,
  project: string,
  directory: string
): Promise<void> {
  const plain = openBytes(key, "task-state", repository, project, await readFile(sealedFile));
  await withTempDirectory(async (temp) => {
    const archive = join(temp, "state.tar.gz");
    await writeFile(archive, plain);
    await mkdir(directory, { recursive: true });
    await runCommand("tar", ["-xzf", "state.tar.gz", "-C", tarPath(temp, directory)], {
      cwd: temp,
    });
  });
}

// The legacy name came from replacing unsafe characters; it carries no manifest.
export function legacyTaskStateArtifactName(repository: string, project: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `task-state-${safe(repository.split("/").join("-"))}-${safe(project)}`;
}

type ArtifactReader = { get(path: string): Promise<unknown> };

// Newest first: runs that uploaded an artifact with this exact name and are successful runs of the
// task workflow on main. An artifact any other workflow uploaded under the same name is ignored.
export async function trustedStateRuns(
  reader: ArtifactReader,
  controlRepository: string,
  name: string
): Promise<number[]> {
  const listing = await reader.get(
    `repos/${controlRepository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20`
  );
  const runIds: number[] = [];
  for (const artifact of getJsonArray(listing, "artifacts")) {
    if (!isJsonRecord(artifact) || artifact.expired === true) continue;
    const runId = getJsonNumber(artifact.workflow_run, "id");
    if (!runId || runIds.includes(runId)) continue;
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    if (
      getJsonString(run, "path") === taskWorkflowPath &&
      getJsonString(run, "head_branch") === "main" &&
      getJsonString(run, "conclusion") === "success"
    ) {
      runIds.push(runId);
    }
  }
  return runIds;
}

export type RestoreOptions = {
  stateRoot: string;
  repository: string;
  project: string;
  isPrivate: boolean;
  key: Buffer | null;
  reader: ArtifactReader;
  controlRepository: string;
  download: (runId: number, name: string, destination: string) => Promise<void>;
};

export async function restoreTaskState(options: RestoreOptions): Promise<string> {
  const { stateRoot, repository, project, isPrivate, key, reader, controlRepository } = options;
  if (isPrivate && key === null) {
    return "No previous task state: a private task source needs AW_ARTIFACT_KEY.";
  }
  const candidate = join(stateRoot, "candidate");
  const opened = join(stateRoot, "opened");
  const names = [taskStateArtifactName(repository, project)];
  if (!isPrivate) names.push(legacyTaskStateArtifactName(repository, project));

  for (const name of names) {
    const isLegacy = name !== names[0];
    for (const runId of await trustedStateRuns(reader, controlRepository, name)) {
      await rm(candidate, { recursive: true, force: true });
      await rm(opened, { recursive: true, force: true });
      await mkdir(candidate, { recursive: true });
      try {
        await options.download(runId, name, candidate);
        if (key !== null && isPrivate) {
          await openStateFile(key, join(candidate, sealedStateFile), repository, project, opened);
        }
      } catch {
        continue;
      }
      const source = isPrivate ? opened : candidate;
      if (!isLegacy && !(await verifyTaskStateDirectory(source, repository, project))) continue;
      if ((await readdir(source)).length === 0) continue;
      await cp(source, join(stateRoot, "previous"), { recursive: true });
      await rm(candidate, { recursive: true, force: true });
      await rm(opened, { recursive: true, force: true });
      return `Restored ${isLegacy ? "legacy-named " : ""}task state from run ${runId}.`;
    }
  }
  await rm(candidate, { recursive: true, force: true });
  return "No previous task state found.";
}

function keyFromEnvironment(): Buffer | null {
  const raw = process.env.AW_ARTIFACT_KEY ?? "";
  return raw === "" ? null : artifactKey(raw);
}

export type TaskLogView = {
  project: string;
  ref: string;
  requestId: string;
};

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

// Run logs of this public repository are world-readable. When the task source is private its project
// name, full commit and request id stay out of them: only short hashes / a 7 character ref remain,
// which is enough to correlate a run without revealing the name.
export function taskLogView(
  isSourcePrivate: boolean,
  values: { project: string; ref: string; requestId: string }
): TaskLogView {
  if (!isSourcePrivate) {
    return { project: values.project, ref: values.ref, requestId: values.requestId };
  }
  return {
    project: `sha256:${shortHash(values.project)}`,
    ref: values.ref.slice(0, 7),
    requestId: `sha256:${shortHash(values.requestId)}`,
  };
}

async function main(): Promise<void> {
  const [command = "", ...args] = process.argv.slice(2);
  switch (command) {
    case "name": {
      const [repository = "", project = ""] = args;
      console.log(taskStateArtifactName(repository, project));
      return;
    }
    case "write": {
      const [directory = "", repository = "", project = "", ref = ""] = args;
      await writeTaskStateManifest(directory, repository, project, ref);
      return;
    }
    case "verify": {
      const [directory = "", repository = "", project = ""] = args;
      if (!(await verifyTaskStateDirectory(directory, repository, project))) {
        process.exitCode = 1;
      }
      return;
    }
    case "log-view": {
      // log-view <private|public> <project> <ref> <request_id> -> three lines: project, ref, request id.
      const [visibility = "", project = "", ref = "", requestId = ""] = args;
      const view = taskLogView(visibility !== "public", { project, ref, requestId });
      console.log(view.project);
      console.log(view.ref);
      console.log(view.requestId);
      return;
    }
    case "restore": {
      // restore <state-root> <repository> <project> <private|public>
      const [stateRoot = "", repository = "", project = "", visibility = ""] = args;
      const token = process.env.GH_TOKEN ?? "";
      const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
      console.log(
        await restoreTaskState({
          stateRoot,
          repository,
          project,
          isPrivate: visibility !== "public",
          key: keyFromEnvironment(),
          reader: new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token),
          controlRepository,
          download: async (runId, name, destination) => {
            await runCommand(
              "gh",
              [
                "run",
                "download",
                String(runId),
                "-R",
                controlRepository,
                "-n",
                name,
                "-D",
                destination,
              ],
              { env: githubEnvironment(token) }
            );
          },
        })
      );
      return;
    }
    case "seal-state": {
      // seal-state <state-root> <repository> <project> <private|public> -> output "path" to upload.
      const [stateRoot = "", repository = "", project = "", visibility = ""] = args;
      let uploadPath = join(stateRoot, "current");
      if (visibility !== "public") {
        const key = keyFromEnvironment();
        uploadPath = "";
        if (key === null) {
          console.log(
            "::warning::Task state of a private source is not kept: set the AW_ARTIFACT_KEY secret."
          );
        } else {
          uploadPath = join(stateRoot, "sealed");
          await mkdir(uploadPath, { recursive: true });
          await sealStateDirectory(
            key,
            join(stateRoot, "current"),
            repository,
            project,
            join(uploadPath, sealedStateFile)
          );
        }
      }
      await appendLines(process.env.GITHUB_OUTPUT, [`path=${uploadPath}`]);
      return;
    }
    case "seal-log": {
      // seal-log <log-file> <repository> <project> <out-directory> -> output "path" to upload.
      const [logFile = "", repository = "", project = "", outDirectory = ""] = args;
      const key = keyFromEnvironment();
      let uploadPath = "";
      if (key === null) {
        console.log("::notice::Set the AW_ARTIFACT_KEY secret to keep failed private task logs.");
      } else {
        await mkdir(outDirectory, { recursive: true });
        const sealed = sealBytes(key, "task-log", repository, project, await readFile(logFile));
        await writeFile(join(outDirectory, sealedLogFile), sealed);
        uploadPath = outDirectory;
      }
      await appendLines(process.env.GITHUB_OUTPUT, [`path=${uploadPath}`]);
      return;
    }
    case "open-log": {
      // open-log <sealed-file> <repository> <project> <out-file>: run by the owner, who holds the key.
      const [sealedFile = "", repository = "", project = "", outFile = ""] = args;
      const key = keyFromEnvironment();
      if (key === null) throw new CliError("AW_ARTIFACT_KEY is required to open a task log.", 64);
      const sealed = await readFile(sealedFile);
      await writeFile(outFile, openBytes(key, "task-log", repository, project, sealed));
      return;
    }
    default:
      throw new CliError(
        "Usage: task-state.ts name|write|verify|log-view|restore|seal-state|seal-log|open-log ...",
        64
      );
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
