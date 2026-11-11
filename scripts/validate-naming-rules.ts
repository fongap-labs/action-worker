import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  runCommand,
  runText,
} from "./runtime-command.ts";
import { validateConfigNames } from "./validate-config-naming.ts";

const nativeNames = new Set([
  "README.md",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODEOWNERS",
  "Dockerfile",
  "Makefile",
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
]);

type NamingPolicy = {
  schema_version: number;
  file_names: {
    max_kebab_segments: number;
    min_new_semantic_segments: number;
    lifecycle_banned_terms: string[];
    generic_warning_terms: string[];
  };
};

async function readNamingPolicy(): Promise<NamingPolicy> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(
        join(dirname(fileURLToPath(import.meta.url)), "../policies/naming.json"),
        "utf8"
      )
    );
  } catch (error) {
    throw new CliError("Unable to read policies/naming.json: " + String(error), 65);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema_version" in value) ||
    value.schema_version !== 1 ||
    !("file_names" in value) ||
    typeof value.file_names !== "object" ||
    value.file_names === null
  ) {
    throw new CliError("Invalid policies/naming.json.", 65);
  }
  const fileNames = value.file_names as Record<string, unknown>;
  const maxSegments = fileNames.max_kebab_segments;
  const minNewSegments = fileNames.min_new_semantic_segments;
  const lifecycle = fileNames.lifecycle_banned_terms;
  const generic = fileNames.generic_warning_terms;
  if (
    typeof maxSegments !== "number" ||
    !Number.isSafeInteger(maxSegments) ||
    maxSegments < 1 ||
    typeof minNewSegments !== "number" ||
    !Number.isSafeInteger(minNewSegments) ||
    minNewSegments < 1 ||
    minNewSegments > maxSegments ||
    !Array.isArray(lifecycle) ||
    !lifecycle.every((item) => typeof item === "string") ||
    !Array.isArray(generic) ||
    !generic.every((item) => typeof item === "string")
  ) {
    throw new CliError("Invalid filename naming policy.", 65);
  }
  return {
    schema_version: 1,
    file_names: {
      max_kebab_segments: maxSegments,
      min_new_semantic_segments: minNewSegments,
      lifecycle_banned_terms: lifecycle,
      generic_warning_terms: generic,
    },
  };
}

function isKebab(stem: string, maxSegments: number): boolean {
  const repeat = "{0," + Math.max(0, maxSegments - 1) + "}";
  return new RegExp("^[a-z0-9]+(?:-[a-z0-9]+)" + repeat + "$").test(stem);
}

function isDocument(name: string): boolean {
  return /^[A-Z0-9]+(?:_[A-Z0-9]+)*\.md$/.test(name);
}

export function hasLifecycleFilenameViolation(
  path: string,
  bannedTerms: readonly string[] = ["new", "final", "latest", "temp", "tmp"]
): boolean {
  if (path.startsWith("projects/")) return false;
  const name = basename(path);
  const stem = parse(name).name;
  const extension = extname(name).slice(1);
  const isControlSurface =
    path.startsWith(".github/") ||
    path.startsWith("scripts/") ||
    path.startsWith("tools/") ||
    ["sh", "ps1", "yml", "yaml", "ts"].includes(extension);
  const segments = stem.split(/[-_.]+/).filter(Boolean);
  return isControlSurface && bannedTerms.some((term) => segments.includes(term));
}

function newFileSegments(path: string): string[] | null {
  if (path.startsWith("projects/")) return null;
  const extension = extname(path).slice(1);
  const controlled =
    path.startsWith(".github/workflows/") ||
    ["sh", "ps1", "py", "rs"].includes(extension) ||
    (extension === "ts" && (path.startsWith("scripts/") || path.startsWith("tests/")));
  if (!controlled) return null;
  let stem = parse(basename(path)).name;
  if (extension === "ts") stem = stem.replace(/\.(?:test|spec)$/, "");
  if (extension === "py" && stem.startsWith("test_")) stem = stem.slice(5);
  if (["__init__", "main", "lib", "build"].includes(stem)) return null;
  return stem.split(/[-_]+/).filter(Boolean);
}

export function commandFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function validateNames(
  base: string,
  head: string
): Promise<{ failures: number; warnings: number; files: number }> {
  const policy = await readNamingPolicy();
  const maxSegments = policy.file_names.max_kebab_segments;
  const minNewSegments = policy.file_names.min_new_semantic_segments;
  const lifecycleTerms = policy.file_names.lifecycle_banned_terms;
  const genericTerms = new Set(policy.file_names.generic_warning_terms);
  const changed = await runText("git", ["diff", "--name-only", "--diff-filter=ACMR", base, head]);
  const added = await runText("git", ["diff", "--name-only", "--diff-filter=A", base, head]);
  const addedPaths = new Set(added ? added.split(/\r?\n/).filter(Boolean) : []);
  const files = changed ? changed.split(/\r?\n/).filter(Boolean) : [];
  let failures = 0;
  let warnings = 0;
  console.log(`Checking ${files.length} changed paths`);
  for (const path of files) {
    if (path.startsWith("projects/")) continue;
    const name = basename(path);
    const stem = parse(name).name;
    const extension = extname(name).slice(1);
    if (nativeNames.has(name)) continue;
    if (extension === "md" && /^[A-Z0-9_]+\.md$/.test(name)) {
      if (!isDocument(name)) {
        console.log(`::error file=${path}::Governance documents must use UPPER_SNAKE_CASE.md.`);
        failures += 1;
      }
      continue;
    }

    const isWorkflow = path.startsWith(".github/workflows/");
    const isShell = ["sh", "ps1"].includes(extension);
    const isTypeScriptSource =
      extension === "ts" && (path.startsWith("scripts/") || path.startsWith("tests/"));
    const typescriptStem = isTypeScriptSource ? stem.replace(/\.(?:test|spec)$/, "") : stem;
    if (
      ((isWorkflow || isShell) && !isKebab(stem, maxSegments)) ||
      (isTypeScriptSource && !isKebab(typescriptStem, maxSegments))
    ) {
      console.log(
        `::error file=${path}::Engineering filenames must use policy-defined kebab-case with at most ${maxSegments} segments.`
      );
      failures += 1;
    }
    if (hasLifecycleFilenameViolation(path, lifecycleTerms)) {
      console.log(
        `::error file=${path}::Engineering control filenames cannot use policy-defined lifecycle labels.`
      );
      failures += 1;
    }
    if (genericTerms.has(stem)) {
      console.log(
        `::warning file=${path}::Filename '${name}' is too broad; name it after its concrete responsibility.`
      );
      warnings += 1;
    }
    if (addedPaths.has(path)) {
      const segments = newFileSegments(path);
      if (segments && segments.length < minNewSegments) {
        console.log(
          `::error file=${path}::New engineering filenames must contain at least ${minNewSegments} semantic segments.`
        );
        failures += 1;
      }
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
  const policy = await readNamingPolicy();
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Naming rules",
    "",
    `- Changed paths: ${result.files}`,
    `- Errors: ${result.failures}`,
    `- Warnings: ${result.warnings}`,
    "",
    `Rule: controlled filenames use kebab-case with at most ${policy.file_names.max_kebab_segments} segments; new source filenames use at least ${policy.file_names.min_new_semantic_segments} semantic segments; external names must identify their owner.`,
  ]);
  if (result.failures > 0) process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
