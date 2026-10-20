import { CliError, handleError, isMain, runText } from "./runtime-command.ts";

const ASCII_ONLY = /^[\x00-\x7F]*$/;
const MAX_SUMMARY_LENGTH = 120;
const ENTRY_PATTERN = /^- ([a-z]+)(?: \[([^\]]+)\])?: (.+)$/;

function isAscii(text: string): boolean {
  return ASCII_ONLY.test(text);
}

function hasMarkdown(text: string): boolean {
  // Detect markdown formatting that shouldn't be in changelog entries
  return /(\*\*|__|\*|_|`|~~|\[.*\]\(.*\))/.test(text);
}

function hasTrailingPeriod(text: string): boolean {
  return text.trimEnd().endsWith(".");
}

function validateChangelog(content: string, filePath: string): string[] {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);
  let inUnreleased = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line === "## [Unreleased]") {
      inUnreleased = true;
      continue;
    }

    if (line.startsWith("## ") && inUnreleased) {
      // Left unreleased section
      inUnreleased = false;
    }

    if (!inUnreleased) continue;

    if (!line.startsWith("- ")) continue;

    // Check ASCII only
    if (!isAscii(line)) {
      const nonAscii = [...line].filter((c) => c.charCodeAt(0) > 127);
      errors.push(
        `${filePath}:${lineNum}: contains non-ASCII characters: ${JSON.stringify(nonAscii.join(""))}`
      );
    }

    // Check entry format
    const match = ENTRY_PATTERN.exec(line);
    if (!match) {
      errors.push(
        `${filePath}:${lineNum}: invalid entry format (expected '- type [attr]: summary'): ${line}`
      );
      continue;
    }

    const [, type, attr, summary] = match;

    // Check summary length
    if (summary.length > MAX_SUMMARY_LENGTH) {
      errors.push(
        `${filePath}:${lineNum}: summary too long (${summary.length} > ${MAX_SUMMARY_LENGTH} chars): ${summary}`
      );
    }

    // Check trailing period
    if (hasTrailingPeriod(summary)) {
      errors.push(
        `${filePath}:${lineNum}: summary should not end with a period: ${summary}`
      );
    }

    // Check markdown formatting
    if (hasMarkdown(summary)) {
      errors.push(
        `${filePath}:${lineNum}: summary contains markdown formatting: ${summary}`
      );
    }

    // Check type is lowercase
    if (type !== type.toLowerCase()) {
      errors.push(
        `${filePath}:${lineNum}: type must be lowercase: ${type}`
      );
    }

    // Check attribute format if present
    if (attr && !/^[a-z]+(,[a-z]+)*$/.test(attr)) {
      errors.push(
        `${filePath}:${lineNum}: invalid attribute format (comma-separated lowercase): ${attr}`
      );
    }
  }

  return errors;
}

export async function validateChangelogFormat(
  base: string,
  head: string,
  root: string,
  changelogFile: string
): Promise<void> {
  // Get the changelog file content at HEAD
  const content = await runText(
    "git",
    ["show", `${head}:${changelogFile}`],
    { cwd: root }
  );

  const errors = validateChangelog(content, changelogFile);

  if (errors.length > 0) {
    for (const err of errors.slice(0, 10)) {
      console.log(`::error file=${err.split(":")[0]}::${err.split(":").slice(1).join(":")}`);
    }
    throw new CliError(
      `::error::CHANGELOG format validation failed (${errors.length} issues). See above for details.`,
      65
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError(
      "Usage: validate-changelog-format.ts <base-sha> <head-sha> <repo-root> <changelog-file>",
      64
    );
  }
  const [base = "", head = "", root = "", changelogFile = ""] = args;
  await validateChangelogFormat(base, head, root, changelogFile);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}