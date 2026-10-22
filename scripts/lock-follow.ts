import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain, runCommand, runText } from "./runtime-command.ts";

// Runs in the sandbox of a follower, with no central credential in its environment. It reads the uv
// version the project requires, installs exactly that version, runs `uv lock` in the project, and
// writes the difference of uv.lock as a patch. The control domain checks the patch before it commits.
//
//   node lock-follow.ts <project-directory-or-empty> <patch-output-file>
//
// The working directory is the target checkout. Only the project's uv.lock may change.

const versionPattern = /^(?:==)?([0-9]+\.[0-9]+\.[0-9]+)$/;

export function requiredUvVersion(pyproject: unknown): string {
  const tool = isJsonRecord(pyproject) ? pyproject.tool : undefined;
  const uv = isJsonRecord(tool) ? tool.uv : undefined;
  const required = isJsonRecord(uv) ? uv["required-version"] : undefined;
  if (typeof required !== "string") {
    throw new CliError(
      "pyproject.toml must declare [tool.uv] required-version for a follower that locks.",
      65
    );
  }
  const match = versionPattern.exec(required.trim());
  if (match?.[1] === undefined) {
    throw new CliError(
      `[tool.uv] required-version must be one exact version such as ==0.9.1: ${required}.`,
      65
    );
  }
  return match[1];
}

export function uvLockPath(projectDirectory: string): string {
  return projectDirectory === "" ? "uv.lock" : `${projectDirectory}/uv.lock`;
}

async function main(): Promise<void> {
  const [projectDirectory = "", patchPath = ""] = process.argv.slice(2);
  if (!patchPath || projectDirectory.startsWith("/") || projectDirectory.includes("..")) {
    throw new CliError(
      "Usage: lock-follow.ts <project-directory-or-empty> <patch-output-file>",
      64
    );
  }
  const projectRoot = projectDirectory === "" ? "." : projectDirectory;

  const pyproject = parseToml(
    await readFile(join(projectRoot, "pyproject.toml"), "utf8")
  ) as unknown;
  const version = requiredUvVersion(pyproject);

  await runCommand(
    "python3",
    ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", `uv==${version}`],
    {
      timeoutMs: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  await runCommand("uv", ["lock"], {
    cwd: projectRoot,
    timeoutMs: 1_200_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const status = await runText("git", ["status", "--porcelain"], { timeoutMs: 60_000 });
  const lockPath = uvLockPath(projectDirectory);
  const lines = status.split("\n").filter((line) => line !== "");
  // A uv.lock that the repository does not track yet has no diff to carry; it is refused, not skipped.
  if (lines.some((line) => line.startsWith("?? ") && line.slice(3).trim() === lockPath)) {
    throw new CliError(
      `${lockPath} is not tracked yet; commit the initial uv.lock before following.`,
      65
    );
  }
  const unexpected = lines.map((line) => line.slice(3).trim()).filter((path) => path !== lockPath);
  if (unexpected.length > 0) {
    throw new CliError(
      `uv lock changed files other than ${lockPath}: ${unexpected.join(", ")}.`,
      65
    );
  }

  // runText trims the trailing newline, and a patch file without its final newline makes git apply
  // report "corrupt patch" at the last line, so the patch is read without trimming.
  const patch = (
    await runCommand("git", ["diff", "--no-color", "--no-ext-diff", "--", lockPath], {
      timeoutMs: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).toString("utf8");
  await writeFile(patchPath, patch, "utf8");
  console.log(`uv ${version} locked ${lockPath}: ${patch === "" ? "no change" : "patch written"}.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
