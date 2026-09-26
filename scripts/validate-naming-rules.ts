import { basename, dirname, extname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfigNames } from "./validate-config-naming.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  runCommand,
  runText,
} from "./runtime-command.ts";

const nativeNames = new Set([
  "README.md", "LICENSE", "LICENSE.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "CODEOWNERS",
  "Dockerfile", "Makefile", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "pnpm-lock.yaml",
  "yarn.lock", "tsconfig.json", "pyproject.toml", "requirements.txt",
]);

function isKebab(stem: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+){0,2}$/.test(stem);
}

function isDocument(name: string): boolean {
  return /^[A-Z0-9]+(?:_[A-Z0-9]+)*\.md$/.test(name);
}

export function commandFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasLifecycleFilenameViolation(path: string): boolean {
  const name = basename(path);
  const stem = parse(name).name;
  const extension = extname(name).slice(1);
  const isControlSurface = path.startsWith(".github/")
    || path.startsWith("scripts/")
    || path.startsWith("tools/")
    || ["sh", "ps1", "yml", "yaml"].includes(extension);
  return isControlSurface && /(^|[-_.])(new|final|latest|temp|tmp)([-_.]|$)/.test(stem);
}

export async function validateNames(base: string, head: string): Promise<{ failures: number; warnings: number; files: number }> {
  const changed = await runText("git", ["diff", "--name-only", "--diff-filter=ACMR", base, head]);
  const files = changed ? changed.split(/\r?\n/).filter(Boolean) : [];
  let failures = 0;
  let warnings = 0;
  console.log(`Checking ${files.length} changed paths`);
  for (const path of files) {
    const name = basename(path);
    const stem = parse(name).name;
    const extension = extname(name).slice(1);
    if (nativeNames.has(name)) {
      continue;
    }
    if (extension === "md" && /^[A-Z0-9_]+\.md$/.test(name)) {
      if (!isDocument(name)) {
        console.log(`::error file=${path}::Governance documents must use UPPER_SNAKE_CASE.md.`);
        failures += 1;
      }
      continue;
    }
    if ((path.startsWith(".github/workflows/") || extension === "sh") && !isKebab(stem)) {
      console.log(`::error file=${path}::Workflow and Shell files must use kebab-case with at most three segments.`);
      failures += 1;
    }
    if (hasLifecycleFilenameViolation(path)) {
      console.log(`::error file=${path}::Engineering control filenames cannot use lifecycle labels such as new/final/latest/temp/tmp.`);
      failures += 1;
    }
    if (/^(?:utils?|helpers?|common|misc|shared)$/.test(stem)) {
      console.log(`::warning file=${path}::Filename '${name}' is too broad; name it after its concrete responsibility.`);
      warnings += 1;
    }
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  try {
    await runCommand("python3", [join(scriptDir, "validate-source-naming.py"), base, head]);
  } catch (error) {
    console.error(commandFailureMessage(error));
    failures += 1;
  }
  failures += await validateConfigNames(base, head);
  return { failures, warnings, files: files.length };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new CliError("Usage: validate-naming-rules.ts <base-sha> <head-sha>", 64);
  }
  const result = await validateNames(args[0] ?? "", args[1] ?? "");
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Naming rules", "", `- Changed paths: ${result.files}`, `- Errors: ${result.failures}`,
    `- Warnings: ${result.warnings}`, "", "Rule: external names must remain identifiable without repository context; semantic completeness takes priority over segment count.",
  ]);
  if (result.failures > 0) {
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
