import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
  runText,
} from "./runtime-command.ts";

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]+/).includes("..")
    && /^[A-Za-z0-9._/-]+$/.test(value);
}

function allowedPaths(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length < 1
    || !value.every(safeRelativePath)
    || new Set(value).size !== value.length
  ) {
    throw new CliError("Dependency repair output path list is invalid.", 65);
  }
  return value as string[];
}

function confined(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new CliError(`Dependency repair path escapes root: ${relative}.`, 77);
  }
  return target;
}

async function workingChanges(root: string): Promise<string[]> {
  const tracked = (await runText("git", ["diff", "--name-only", "--no-renames"], { cwd: root }))
    .split(/\r?\n/)
    .filter(Boolean);
  const untracked = (await runText("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root }))
    .split(/\r?\n/)
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

async function main(): Promise<void> {
  const [targetRoot = "", stagingRoot = "", rawPaths = ""] = process.argv.slice(2);
  if (!targetRoot || !stagingRoot || !rawPaths) {
    throw new CliError(
      "Usage: collect-dependency-repair.ts <target-root> <staging-root> <output-paths-json>",
      64,
    );
  }
  const outputs = allowedPaths(
    parseJson(rawPaths, "Dependency repair output paths must be valid JSON.", 64),
  );
  const allowed = new Set(outputs);
  const changed = await workingChanges(targetRoot);
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new CliError(
      `Dependency repair changed paths outside the grant: ${unexpected.join(", ")}.`,
      77,
    );
  }
  if (changed.length === 0) {
    await appendLines(process.env.GITHUB_OUTPUT, ["changed=false"]);
    console.log(JSON.stringify({ changed: false, outputs: [] }));
    return;
  }

  for (const relative of changed) {
    const source = confined(targetRoot, relative);
    const details = await stat(source);
    if (!details.isFile() || details.size > 50 * 1024 * 1024) {
      throw new CliError(`Dependency repair output is not an allowed regular file: ${relative}.`, 66);
    }
    const destination = confined(stagingRoot, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  await appendLines(process.env.GITHUB_OUTPUT, [
    "changed=true",
    `changed_paths_json=${JSON.stringify(changed)}`,
  ]);
  console.log(JSON.stringify({ changed: true, outputs: changed }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
