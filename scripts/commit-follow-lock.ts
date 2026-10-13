import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commitFiles, type FileChange, readFileAt } from "./follow-github.ts";
import { GithubReader, getJsonString, isJsonRecord } from "./github-api.ts";
import { uvLockPath } from "./lock-follow.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
} from "./runtime-command.ts";

// Control domain. For each follower whose sandbox produced a uv.lock patch: check that the patch is
// a plain change to that one file, check that the branch has not moved since the sandbox ran, apply
// the patch to the current file in a scratch directory, and commit the one resulting file.
//
//   FOLLOW_LOCK_DIR=<directory of follow-lock artifacts> node commit-follow-lock.ts
//
// Each artifact directory holds follow-lock.json and uv-lock.patch.

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const projectPattern = /^projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const maxPatchBytes = 16 * 1024 * 1024;
const maxLockBytes = 16 * 1024 * 1024;

export type FollowLockRequest = {
  repository: string;
  branch: string;
  head_sha: string;
  project_dir: string;
};

export function parseFollowLockRequest(value: unknown): FollowLockRequest {
  if (!isJsonRecord(value)) {
    throw new CliError("Follow lock request must be a JSON object.", 65);
  }
  const repository = getJsonString(value, "repository");
  const branch = getJsonString(value, "branch");
  const headSha = getJsonString(value, "head_sha");
  const projectDir = getJsonString(value, "project_dir");
  if (
    !repositoryPattern.test(repository) ||
    !/^aw\/follow\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) ||
    !shaPattern.test(headSha) ||
    (projectDir !== "" && !projectPattern.test(projectDir))
  ) {
    throw new CliError("Follow lock request is invalid.", 65);
  }
  return { repository, branch, head_sha: headSha, project_dir: projectDir };
}

// The patch may only change the given uv.lock in place: one file, no new, deleted or renamed file.
// Header lines are checked before the first hunk; hunk bodies are checked by their line prefixes only,
// because a line of the lock file that starts with "--" looks like a header once it is removed.
export function validateLockPatch(patch: string, lockPath: string): void {
  if (patch === "") return;
  if (Buffer.byteLength(patch, "utf8") > maxPatchBytes) {
    throw new CliError("uv.lock patch is larger than 16 MiB.", 65);
  }
  const lines = patch.split("\n");
  let inHunk = false;
  let fileHeaders = 0;
  for (const line of lines) {
    if (line === "") continue;
    if (!inHunk) {
      if (line.startsWith("diff --git ")) {
        fileHeaders += 1;
        if (line !== `diff --git a/${lockPath} b/${lockPath}`) {
          throw new CliError(`uv.lock patch must change exactly ${lockPath}.`, 65);
        }
        continue;
      }
      if (line.startsWith("index ")) continue;
      if (line === `--- a/${lockPath}` || line === `+++ b/${lockPath}`) continue;
      if (line.startsWith("@@ ")) {
        inHunk = true;
        continue;
      }
      throw new CliError(`uv.lock patch contains an unsupported header: ${line.slice(0, 80)}.`, 65);
    }
    if (line.startsWith("@@ ") || /^[ +\-\\]/.test(line)) continue;
    throw new CliError(`uv.lock patch contains an unsupported change: ${line.slice(0, 80)}.`, 65);
  }
  if (fileHeaders !== 1 || !inHunk) {
    throw new CliError(`uv.lock patch must change exactly ${lockPath}.`, 65);
  }
}

async function applyPatch(lockPath: string, current: string, patch: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "aw-follow-lock-"));
  try {
    await mkdir(dirname(join(scratch, lockPath)), { recursive: true });
    await writeFile(join(scratch, lockPath), current, "utf8");
    const patchFile = join(scratch, "uv-lock.patch");
    await writeFile(patchFile, patch, "utf8");
    await runCommand("git", ["apply", "--check", patchFile], { cwd: scratch, timeoutMs: 60_000 });
    await runCommand("git", ["apply", patchFile], { cwd: scratch, timeoutMs: 60_000 });
    return await readFile(join(scratch, lockPath), "utf8");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function commitOne(
  reader: GithubReader,
  token: string,
  request: FollowLockRequest,
  patch: string
): Promise<string | null> {
  const lockPath = uvLockPath(request.project_dir);
  validateLockPatch(patch, lockPath);
  if (patch === "") {
    console.log(`No uv.lock change for ${request.repository} ${request.branch}.`);
    return null;
  }

  const ref = await reader.get(`repos/${request.repository}/git/ref/heads/${request.branch}`);
  const head = getJsonString(isJsonRecord(ref) ? ref.object : undefined, "sha");
  if (head !== request.head_sha) {
    throw new CliError(
      `Branch ${request.branch} in ${request.repository} moved after the lock ran; refusing a stale patch.`,
      65
    );
  }
  const current = await readFileAt(reader, request.repository, lockPath, head, maxLockBytes);
  if (current === null) {
    throw new CliError(
      `${lockPath} is not tracked on ${request.branch}; a patch cannot apply.`,
      65
    );
  }
  const next = await applyPatch(lockPath, current, patch);
  if (next === current) return null;

  const changes: FileChange[] = [{ path: lockPath, text: next }];
  return await commitFiles({
    repository: request.repository,
    branch: request.branch,
    expectedHead: head,
    changes,
    message: "chore(follow): refresh uv.lock for pinned upstream",
    token,
  });
}

async function main(): Promise<void> {
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const directory = process.env.FOLLOW_LOCK_DIR ?? "";
  if (!token || !directory) {
    throw new CliError("AW_CONTROL_TOKEN and FOLLOW_LOCK_DIR are required.", 64);
  }
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const results: string[] = [];
  for (const entry of (await readdir(directory)).sort()) {
    const folder = join(directory, entry);
    const request = parseFollowLockRequest(
      parseJson(
        await readFile(join(folder, "follow-lock.json"), "utf8"),
        "Follow lock request must be valid JSON.",
        65
      )
    );
    const patch = await readFile(join(folder, "uv-lock.patch"), "utf8");
    const commit = await commitOne(reader, token, request, patch);
    results.push(
      `${request.repository} ${request.branch}: ${commit === null ? "no change" : commit}`
    );
  }
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Follow uv.lock",
    "",
    ...results.map((line) => `- ${line}`),
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
