import { extname } from "node:path";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  runText,
} from "./runtime-command.ts";

const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const MARKDOWN = /\.md$/i;
const LOCALIZATION = /(^|\/)(?:i18n|locales?|translations?|messages)(\/|$)|(?:^|[._-])zh(?:[-_.](?:CN|Hans))?(?:[._-]|$)/i;
const WORKFLOW = /^\.github\/workflows\/.*\.ya?ml$/i;
const CONFIG_KEY = /(?:^|\s)[^:#"'\s]*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][^:#"']*\s*:/u;
const MACHINE_TEXT = /\b(?:console\.(?:log|error|warn|info|debug)|logger\w*|log\w*\s*\(|throw\s+new\s+\w*Error|new\s+\w*Error\s*\(|raise\s+\w*Error|logging\.|print\s*\()/i;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|py|rs|go|java)$/i;

export function containsHan(value: string): boolean {
  return HAN.test(value);
}

export function assertEnglishText(label: string, value: string): void {
  if (containsHan(value)) {
    throw new CliError(`::error::${label} must use English engineering text.`, 65);
  }
}

function stripQuotedStrings(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

export function engineeringLineViolation(path: string, line: string): string | null {
  if (!containsHan(line)) {
    return null;
  }
  if (path === "CHANGELOG.md") {
    return "CHANGELOG entries must use English.";
  }
  if (MARKDOWN.test(path) || LOCALIZATION.test(path)) {
    return null;
  }
  if (WORKFLOW.test(path)) {
    return "Workflow engineering text must use English.";
  }
  if (CONFIG_KEY.test(line)) {
    return "Configuration keys must use English.";
  }
  if (TEST_FILE.test(path)) {
    return null;
  }
  if (MACHINE_TEXT.test(line)) {
    return "Logs and errors must use English.";
  }
  if (containsHan(stripQuotedStrings(line))) {
    return "Engineering identifiers and comments must use English.";
  }
  return null;
}

export async function validateEngineeringDiff(
  base: string,
  head: string,
  root: string,
): Promise<{ files: number; additions: number; failures: number }> {
  const diff = await runText("git", ["diff", "--unified=0", "--diff-filter=ACMR", base, head], { cwd: root });
  let path = "";
  let files = 0;
  let additions = 0;
  let failures = 0;
  const seen = new Set<string>();
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ b/")) {
      path = raw.slice(6);
      if (!seen.has(path)) {
        seen.add(path);
        files += 1;
      }
      continue;
    }
    if (!path || !raw.startsWith("+") || raw.startsWith("+++")) {
      continue;
    }
    additions += 1;
    const line = raw.slice(1);
    const violation = engineeringLineViolation(path, line);
    if (violation) {
      console.log(`::error file=${path}::${violation}`);
      failures += 1;
    }
  }
  return { files, additions, failures };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new CliError("Usage: validate-engineering-language.ts <base-sha> <head-sha> <repo-root>", 64);
  }
  const result = await validateEngineeringDiff(args[0] ?? "", args[1] ?? "", args[2] ?? "");
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Engineering language",
    "",
    `- Changed files: ${result.files}`,
    `- Added lines: ${result.additions}`,
    `- Violations: ${result.failures}`,
    "",
    "Rule: engineering diffs, PR titles, and CHANGELOG entries use English; documentation and localization content are exempt.",
  ]);
  if (result.failures > 0) {
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
