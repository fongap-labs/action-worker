import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

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
    default:
      throw new CliError("Usage: task-state.ts name|write|verify|log-view ...", 64);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
